import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

const app = express();

/* ================= ENV ================= */

const REQUIRED_ENV = [
"FB_PROJECT_ID",
"FB_CLIENT_EMAIL",
"FB_PRIVATE_KEY",
"FB_DB_URL",
"ZAPUPI_API_KEY",
"ZAPUPI_SECRET_KEY"
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
privateKey:
process.env.FB_PRIVATE_KEY.replace(/\\n/g,"\n")
}),
databaseURL:process.env.FB_DB_URL
});
}

const db = admin.database();

/* ================= AUTH ================= */

async function verifyFirebaseToken(req,res,next){

try{

const token =
req.headers.authorization?.split("Bearer ")[1];

if(!token)
return res.status(401).json({
error:"Unauthorized"
});

const decoded =
await admin.auth().verifyIdToken(token);

req.uid = decoded.uid;

next();

}catch{

return res.status(401).json({
error:"Invalid token"
});
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
✅ JOIN MATCH (FINAL SECURE VERSION)
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
[`users/${uid}/transactions/${publicMatchId}`]:{
transactionId:publicMatchId,
type:"match_entry",
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

/* ================= START ================= */

app.listen(
process.env.PORT||3000,
()=>console.log("Server running securely")
);
