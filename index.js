import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";
import { runCronJobs } from "./services/leaderboardCron.js";

const app = express();

/* ================= ENV ================= */

const REQUIRED_ENV = [
"FB_PROJECT_ID",
"FB_CLIENT_EMAIL",
"FB_PRIVATE_KEY",
"FB_DB_URL",
"ZAPUPI_API_KEY",
"ZAPUPI_SECRET_KEY",
"ADMIN_UID"
];

for (const key of REQUIRED_ENV) {
if (!process.env[key]) {
console.error(`Missing ENV variable: ${key}`);
process.exit(1);
}
}

/* ================= CORS ================= */

const allowedOrigins = [
"https://testingwithme.infinityfree.me",
"https://elitepros-backend.onrender.com"
];

app.use(cors({
origin(origin,callback){

if(!origin) return callback(null,true);

if(allowedOrigins.includes(origin))
return callback(null,true);

console.log("Blocked CORS:",origin);
callback(new Error("Not allowed by CORS"));
},
methods:["GET","POST","OPTIONS"],
allowedHeaders:["Content-Type","Authorization"],
credentials:true
}));

app.options("*",cors());

app.use(express.json());
app.use(express.urlencoded({extended:true}));

/* ================= FIREBASE ================= */

if(!admin.apps.length){
admin.initializeApp({
credential:admin.credential.cert({
projectId:process.env.FB_PROJECT_ID,
clientEmail:process.env.FB_CLIENT_EMAIL,
privateKey:process.env.FB_PRIVATE_KEY.replace(/\\n/g,"\n")
}),
databaseURL:process.env.FB_DB_URL
});
}

const db = admin.database();

/* ================= AUTH ================= */

async function verifyFirebaseToken(req,res,next){
try{
const token = req.headers.authorization?.split("Bearer ")[1];
if(!token) return res.status(401).json({error:"Unauthorized"});
const decoded = await admin.auth().verifyIdToken(token);
req.uid = decoded.uid;
next();
}catch{
return res.status(401).json({error:"Invalid token"});
}
}

async function verifyAdmin(req,res,next){
try{
const token = req.headers.authorization?.split("Bearer ")[1];
if(!token) return res.status(401).json({error:"Unauthorized"});
const decoded = await admin.auth().verifyIdToken(token);
if(decoded.uid !== process.env.ADMIN_UID)
return res.status(403).json({error:"Admin only"});
req.uid = decoded.uid;
next();
}catch{
return res.status(401).json({error:"Invalid token"});
}
}

/* ================= ROOT ================= */

app.get("/",(_,res)=>
res.json({status:"OK"})
);

/* ======================================================
CREATE PAYMENT
====================================================== */

app.post("/create-payment",
verifyFirebaseToken,
async(req,res)=>{

try{

const uid=req.uid;
const amount=Number(req.body.amount);

if(!Number.isFinite(amount)||amount<1)
return res.status(400)
.json({error:"Invalid amount"});

const orderId="ORD"+Date.now();

const redirectUrl=
"https://testingwithme.infinityfree.me/wallet.html";

const body=new URLSearchParams({
token_key:process.env.ZAPUPI_API_KEY,
secret_key:process.env.ZAPUPI_SECRET_KEY,
amount:amount.toString(),
order_id:orderId,
remark:"Wallet Deposit",
redirect_url:redirectUrl
});

const zapupiRes=await fetch(
"https://api.zapupi.com/api/create-order",
{
method:"POST",
headers:{
"Content-Type":
"application/x-www-form-urlencoded"
},
body:body.toString()
});

const zapupi=
JSON.parse(await zapupiRes.text());

if(zapupi.status!=="success")
return res.status(502)
.json({error:"Gateway error"});

await db.ref(
`users/${uid}/transactions/${orderId}`
).set({
transactionId:orderId,
type:"deposit",
amount,
status:"pending",
timestamp:Date.now()
});

await db.ref(`orders/${orderId}`).set({
uid,
amount,
status:"pending",
locked:false,
createdAt:Date.now()
});

res.json({
order_id:orderId,
payment_url:zapupi.payment_url
});

}catch(e){

console.error("CREATE PAYMENT ERROR:",e);

res.status(500)
.json({error:"Create payment failed"});
}
});

/* ======================================================
WEBHOOK
====================================================== */

app.post("/zapupi-webhook",async(req,res)=>{

try{

const{order_id}=req.body;

if(!order_id)
return res.status(400)
.send("Invalid webhook");

const orderRef=
db.ref(`orders/${order_id}`);

const lockResult=
await orderRef.transaction(order=>{

if(!order)return order;
if(order.status==="success")
return order;

if(order.locked===true)
return;

order.locked=true;

return order;
});

if(!lockResult.committed)
return res.status(200)
.send("Already processing");

const order=
lockResult.snapshot.val();

if(!order)
return res.status(404)
.send("Order not found");

const{uid,amount}=order;

const verifyBody=
new URLSearchParams({
token_key:process.env.ZAPUPI_API_KEY,
secret_key:process.env.ZAPUPI_SECRET_KEY,
order_id
});

const verifyRes=
await fetch(
"https://api.zapupi.com/api/order-status",
{
method:"POST",
headers:{
"Content-Type":
"application/x-www-form-urlencoded"
},
body:verifyBody.toString()
});

const zapupi=
JSON.parse(await verifyRes.text());

if(
!zapupi.data ||
String(zapupi.data.status)
.toLowerCase()!=="success"
){

await orderRef.update({
locked:false
});

return res.status(200)
.send("Not paid");
}

/* CREDIT WALLET */

await db.ref(
`users/${uid}/wallet/deposited`
).transaction(
v=>(Number(v)||0)+Number(amount)
);

await db.ref().update({

[`orders/${order_id}/status`]:"success",
[`orders/${order_id}/locked`]:false,

[`users/${uid}/transactions/${order_id}/status`]:"success",

[`users/${uid}/transactions/${order_id}/confirmedAt`]:
Date.now()

});

res.send("OK");

}catch(err){

console.error("WEBHOOK ERROR:",err);

res.status(500).send("Error");
}
});

/* ======================================================
JOIN MATCH (FINAL SECURE VERSION)
====================================================== */

app.post(
"/join-match",
verifyFirebaseToken,
async(req,res)=>{

try{

const uid=req.uid;
const{matchId,ign}=req.body;

if(!matchId||!ign)
return res.json({error:"INVALID_DATA"});

const matchRef=db.ref(`matches/${matchId}`);
const walletRef=db.ref(`users/${uid}/wallet`);
const playerRef=
db.ref(`matches/${matchId}/players/${uid}`);

/* SLOT LOCK */

const matchTxn=
await matchRef.transaction(match=>{

if(!match)return match;

if(!match.players)
match.players={};

const count=
Object.keys(match.players).length;

if(count>=match.slots)
return;

if(match.players[uid])
return match;

match.players[uid]={_locking:true};

return match;

});

if(!matchTxn.committed)
return res.json({error:"MATCH_FULL"});

const matchData=
matchTxn.snapshot.val();

const entryFee=
Number(matchData.entryFee||0);

const publicMatchId=
matchData.matchId||matchId;

/* WALLET */

const walletSnap=
await walletRef.once("value");

const wallet=
walletSnap.val()||{};

let dep=
Number(wallet.deposited||0);

let win=
Number(wallet.winnings||0);

if(dep+win<entryFee){

await playerRef.remove();

return res.json({
error:"INSUFFICIENT_BALANCE"
});
}

let depositUsed=0;
let winningsUsed=0;

if(dep>=entryFee){

depositUsed=entryFee;
dep-=entryFee;

}else{

depositUsed=dep;
winningsUsed=
entryFee-dep;

dep=0;
win-=winningsUsed;
}

await walletRef.update({
deposited:dep,
winnings:win
});

/* FINAL SAVE */

await db.ref().update({

[`matches/${matchId}/players/${uid}`]:{
ign,
depositUsed,
winningsUsed,
joinedAt:Date.now()
},

[`users/${uid}/myMatches/${matchId}`]:{
joinedAt:Date.now()
},

/* UPDATE IGN */
[`users/${uid}/ign`]:ign,

/* ENTRY TRANSACTION */
[`users/${uid}/transactions/${publicMatchId}_Join`]:{
transactionId:`${publicMatchId}_Join`,
type:"entry",
amount:-entryFee,
status:"success",
reason:"Match Joined",
timestamp:Date.now()
}

});

res.json({status:"SUCCESS"});

}catch(err){

console.error("JOIN ERROR:",err);

res.status(500).json({
error:"SERVER_ERROR"
});
}
});

/* ======================================================
ADMIN CREATE MATCH
====================================================== */

app.post("/admin/create-match",verifyAdmin,async(req,res)=>{
try{
const data=req.body;

const duplicate=
await db.ref("matches")
.orderByChild("matchId")
.equalTo(data.matchId)
.once("value");

if(duplicate.exists())
return res.status(400).json({error:"MatchId exists"});

const ref=db.ref("matches").push();

await ref.set({
matchId:data.matchId,
name:data.name,
banner:data.banner||"",
entryFee:Number(data.entryFee)||0,
slots:Number(data.slots)||0,
perKill:Number(data.perKill)||0,
prizePool:Number(data.prizePool)||0,
prizeDistribution:data.prizeDistribution||{},
map:data.map||"",
type:data.type||"",
gameMode:data.gameMode||"",
rules:data.rules||"",
matchSettings:data.matchSettings||{},
matchTimings:data.matchTimings||{},
status:"upcoming",
players:{},
results:null,
locked:false,
resultsCredited:false,
cancelledProcessed:false,
createdAt:Date.now()
});

res.json({status:"SUCCESS",matchKey:ref.key});
}catch(e){
res.status(500).json({error:"SERVER_ERROR"});
}
});

/* ======================================================
ADMIN UPDATE MATCH
====================================================== */

app.post("/admin/update-match",verifyAdmin,async(req,res)=>{
const {matchKey,updates}=req.body;
await db.ref(`matches/${matchKey}`).update(updates);
res.json({status:"UPDATED"});
});

/* ======================================================
ADMIN DUPLICATE MATCH
====================================================== */

app.post("/admin/duplicate-match",verifyAdmin,async(req,res)=>{
const {matchKey,newMatchId}=req.body;

const snap=await db.ref(`matches/${matchKey}`).once("value");
if(!snap.exists()) return res.json({error:"NOT_FOUND"});

const match=snap.val();
delete match.players;
delete match.results;

match.matchId=newMatchId;
match.status="upcoming";
match.locked=false;
match.resultsCredited=false;
match.cancelledProcessed=false;

const newRef=db.ref("matches").push();
await newRef.set(match);

res.json({status:"DUPLICATED",matchKey:newRef.key});
});

/* ======================================================
ADMIN SET ROOM
====================================================== */

app.post("/admin/set-room",verifyAdmin,async(req,res)=>{
const {matchKey,roomId,roomPassword}=req.body;
await db.ref(`matches/${matchKey}`).update({
roomId,
roomPassword
});
res.json({status:"ROOM_UPDATED"});
});

/* ======================================================
ADMIN UPDATE STATUS
====================================================== */

app.post("/admin/update-status",verifyAdmin,async(req,res)=>{
const {matchKey,newStatus}=req.body;

await db.ref(`matches/${matchKey}/status`).set(newStatus);

if(newStatus==="cancelled"){
await cancelMatch(matchKey);
}

res.json({status:"UPDATED"});
});

/* ======================================================
CANCEL MATCH (REFUND) - ATOMIC & IDEMPOTENT
====================================================== */

async function cancelMatch(matchKey){

const matchRef = db.ref(`matches/${matchKey}`);

const lockTxn = await matchRef.transaction(match => {
if(!match) return match;
if(match.cancelledProcessed) return match;
match.cancelledProcessed = true;
return match;
});

if(!lockTxn.committed || !lockTxn.snapshot.val()) return;

const match = lockTxn.snapshot.val();
const players = match.players||{};
const publicMatchId = match.matchId;

for(const uid in players){

const p = players[uid];

await db.ref(`users/${uid}/wallet/deposited`)
.transaction(v=>(Number(v)||0)+(Number(p.depositUsed)||0));

await db.ref(`users/${uid}/wallet/winnings`)
.transaction(v=>(Number(v)||0)+(Number(p.winningsUsed)||0));

const txnId=`${publicMatchId}_Refund`;

await db.ref(`users/${uid}/transactions/${txnId}`)
.set({
transactionId:txnId,
matchId:publicMatchId,
type:"Refund",
reason:"Match Cancelled",
amount:(Number(p.depositUsed)||0)+(Number(p.winningsUsed)||0),
status:"Success",
timestamp:Date.now()
});
}
}

/* ======================================================
ADMIN SUBMIT RESULTS - ATOMIC CREDIT CHECK
====================================================== */

app.post("/admin/submit-results",verifyAdmin,async(req,res)=>{

const {matchKey,results}=req.body;

const matchRef = db.ref(`matches/${matchKey}`);

const creditTxn = await matchRef.transaction(match => {
if(!match) return match;
if(match.resultsCredited) return; // abort - already credited
match.resultsCredited = true;
return match;
});

if(!creditTxn.committed) return res.json({error:"TRANSACTION_FAILED"});

const match = creditTxn.snapshot.val();
if(!match) return res.json({error:"NOT_FOUND"});

const players = match.players||{};
const publicMatchId = match.matchId;

for(const uid in results){

const {rank,kills}=results[uid];

const rankPrize=
Number(match.prizeDistribution?.[rank]||0);

const killPrize=
Number(match.perKill||0)*Number(kills||0);

const total=rankPrize+killPrize;

await db.ref(`users/${uid}/wallet/winnings`)
.transaction(v=>(Number(v)||0)+total);

const txnId=`${publicMatchId}_Winnings`;

await db.ref(`users/${uid}/transactions/${txnId}`)
.set({
transactionId:txnId,
matchId:publicMatchId,
type:"Match Winnings",
reason:"Match Winnings",
amount:total,
rank,
kills,
rankPrize,
killPrize,
status:"Success",
timestamp:Date.now()
});
}

await matchRef.update({
results
});

res.json({status:"RESULTS_SUBMITTED"});
});

/* ======================================================
ADMIN UPDATE RESULTS NO CREDIT
====================================================== */

app.post("/admin/update-results-only",verifyAdmin,async(req,res)=>{
const {matchKey,results}=req.body;
await db.ref(`matches/${matchKey}`)
.update({
results,
status:"completed"
});
res.json({status:"UPDATED_ONLY"});
});

/* ======================================================
ADMIN DELETE RESULTS
====================================================== */

app.post("/admin/delete-results",verifyAdmin,async(req,res)=>{
const {matchKey}=req.body;

const snap=
await db.ref(`matches/${matchKey}/resultsCredited`)
.once("value");

if(snap.val())
return res.json({error:"Cannot delete credited results"});

await db.ref(`matches/${matchKey}/results`)
.remove();

res.json({status:"DELETED"});
});

/* ======================================================
USER HOME - GET DASHBOARD DATA
====================================================== */

app.get("/api/home", verifyFirebaseToken, async (req, res) => {
  try {

    const uid = req.uid;

    const userSnap = await db.ref(`users/${uid}`).once("value");
    const user = userSnap.val();

    if (!user) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    if (user.status === "banned") {
      return res.json({ banned: true, reason: user.banReason || "Account suspended" });
    }

    const wallet = user.wallet || { deposited: 0, winnings: 0 };

    const totalBalance =
      Number(wallet.deposited || 0) +
      Number(wallet.winnings || 0);

    /* ANNOUNCEMENT */
    const announcementSnap = await db
      .ref("announcements")
      .orderByChild("timestamp")
      .limitToLast(1)
      .once("value");

    let announcement = "Welcome to ElitePros!";

    if (announcementSnap.exists()) {
      const val = Object.values(announcementSnap.val())[0];
      if (val.active !== false) {
        announcement = val.message || val.title || announcement;
      }
    }

    /* BANNERS */
    const bannerSnap = await db.ref("banners").once("value");

    let banners = [];

    if (bannerSnap.exists()) {
      banners = Object.values(bannerSnap.val())
        .filter(b => b.active !== false)
        .sort((a, b) => (a.order || 999) - (b.order || 999));
    }

    /* GAME MODES */
    const gameModesSnap = await db.ref("gameModes").once("value");

    let gameModes = [];

    if (gameModesSnap.exists()) {
      gameModes = Object.values(gameModesSnap.val())
        .filter(m => m.active !== false)
        .sort((a, b) => (a.order || 999) - (b.order || 999));
    }

    res.json({
      banned: false,
      user: {
        username: user.username || user.email?.split("@")[0] || "Player"
      },
      wallet: {
        deposited: Number(wallet.deposited || 0),
        winnings: Number(wallet.winnings || 0),
        total: totalBalance
      },
      announcement,
      banners,
      gameModes
    });

  } catch (err) {
    console.error("HOME API ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER - GET LEADERBOARD
====================================================== */

app.get("/api/leaderboard", async (req, res) => {

  try {

    const filter = req.query.filter || "today";

    const snap = await db.ref("leaderboard").child(filter).once("value");

    if (!snap.exists()) {
      return res.json({ players: [] });
    }

    const players = Object.values(snap.val())
      .sort((a, b) => (b.winnings || 0) - (a.winnings || 0));

    res.json({ players });

  } catch (err) {
    res.status(500).json({ error: "SERVER_ERROR" });
  }

});

/* ======================================================
USER - GET ACCOUNT STATS
====================================================== */

app.get("/api/account", verifyFirebaseToken, async (req, res) => {

  try {

    const uid = req.uid;

    const myMatchesSnap = await db.ref(`users/${uid}/myMatches`).once("value");

    const totalMatches = myMatchesSnap.exists()
      ? Object.keys(myMatchesSnap.val()).length
      : 0;

    const transactionsSnap = await db.ref(`users/${uid}/transactions`).once("value");

    let lifetimeWinnings = 0;

    if (transactionsSnap.exists()) {
      Object.values(transactionsSnap.val()).forEach(tx => {
        if (tx.type === "Match Winnings") {
          lifetimeWinnings += Number(tx.amount || 0);
        }
      });
    }

    res.json({
      totalMatches,
      lifetimeWinnings
    });

  } catch (err) {
    res.status(500).json({ error: "SERVER_ERROR" });
  }

});

/* ================= START ================= */

app.listen(
process.env.PORT||3000,
()=>console.log("Server running securely")
);

/* ================= CRON LOOP ================= */

console.log("Cron system initialized inside main backend");

setInterval(async () => {
  try {
    await runCronJobs();
  } catch (err) {
    console.error("Cron error:", err);
  }
}, 60000); // runs every 60 seconds
