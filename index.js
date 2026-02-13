import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

const app = express();

/* ===============================
ENV CHECK
=============================== */
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

/* ===============================
MIDDLEWARE
=============================== */
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===============================
FIREBASE INIT
=============================== */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FB_PROJECT_ID,
      clientEmail: process.env.FB_CLIENT_EMAIL,
      privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
    }),
    databaseURL: process.env.FB_DB_URL
  });
}

const db = admin.database();

/* ===============================
HELPERS
=============================== */

function txnId(prefix){
  return `${prefix}_${Date.now()}_${Math.floor(Math.random()*100000)}`;
}

function validTransition(type, oldStatus, newStatus){
  const rules = {
    deposit: { pending: ["success","failed"] },
    withdrawal: { pending: ["success","rejected"] }
  };
  return rules[type]?.[oldStatus]?.includes(newStatus);
}

/* ===============================
AUTH
=============================== */
async function verifyFirebaseToken(req,res,next){
  try{
    const h=req.headers.authorization;
    if(!h?.startsWith("Bearer ")) return res.status(401).json({error:"Unauthorized"});
    const decoded=await admin.auth().verifyIdToken(h.split("Bearer ")[1]);
    req.uid=decoded.uid;
    next();
  }catch{
    res.status(401).json({error:"Invalid token"});
  }
}

async function verifyAdmin(req,res,next){
  const snap=await db.ref(`admins/${req.uid}`).once("value");
  if(snap.val()===true) return next();
  res.status(403).json({error:"Admin only"});
}

/* ===============================
ROOT
=============================== */
app.get("/",(_,res)=>res.json({status:"OK"}));

/* ===============================
CREATE PAYMENT
=============================== */
app.post("/create-payment",verifyFirebaseToken,async(req,res)=>{
try{
const uid=req.uid;
const amount=Number(req.body.amount);
if(!Number.isFinite(amount)||amount<1) return res.status(400).json({error:"Invalid amount"});

const orderId="ORD"+Date.now();

const body=new URLSearchParams({
token_key:process.env.ZAPUPI_API_KEY,
secret_key:process.env.ZAPUPI_SECRET_KEY,
amount:amount.toString(),
order_id:orderId,
remark:"Wallet Deposit",
redirect_url:"https://imaginative-lolly-654a8a.netlify.app/wallet.html?order_id="+orderId
});

const r=await fetch("https://api.zapupi.com/api/create-order",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()});
const zapupi=JSON.parse(await r.text());

if(zapupi.status!=="success") return res.status(502).json({error:"Gateway error"});

await db.ref(`users/${uid}/transactions/${orderId}`).set({
transactionId:orderId,
type:"deposit",
amount,
status:"pending",
timestamp:Date.now()
});

res.json({order_id:orderId,payment_url:zapupi.payment_url});
}catch(e){console.error(e);res.status(500).json({error:"Server"});}
});

/* ===============================
VERIFY PAYMENT
=============================== */
app.post("/verify-payment",verifyFirebaseToken,async(req,res)=>{
try{
const uid=req.uid;
const {orderId}=req.body;

const txnRef=db.ref(`users/${uid}/transactions/${orderId}`);
const snap=await txnRef.once("value");
if(!snap.exists()) return res.json({status:"NOT_FOUND"});
if(snap.val().status==="success") return res.json({status:"SUCCESS"});

const body=new URLSearchParams({
token_key:process.env.ZAPUPI_API_KEY,
secret_key:process.env.ZAPUPI_SECRET_KEY,
order_id:orderId
});

const r=await fetch("https://api.zapupi.com/api/order-status",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()});
const zapupi=JSON.parse(await r.text());

if(zapupi.status!=="success") return res.json({status:"PENDING"});

await db.ref(`users/${uid}/wallet/winnings`).transaction(v=>(Number(v)||0)+Number(snap.val().amount));

await txnRef.update({status:"success"});
res.json({status:"SUCCESS"});
}catch{res.status(500).json({error:"Server"});}
});

/* ===============================
REQUEST WITHDRAWAL
=============================== */
app.post("/request-withdraw",verifyFirebaseToken,async(req,res)=>{
try{
const uid=req.uid;
const amount=Number(req.body.amount);
const upiId=String(req.body.upiId||"");

if(!Number.isFinite(amount)||amount<=0) return res.status(400).json({error:"Invalid amount"});

const walletRef=db.ref(`users/${uid}/wallet/winnings`);
let allowed=false;

await walletRef.transaction(v=>{
v=Number(v)||0;
if(v<amount) return;
allowed=true;
return v-amount;
});

if(!allowed) return res.status(403).json({error:"Insufficient winnings"});

const id=txnId("WDR");

const data={
transactionId:id,
type:"withdrawal",
amount,
upiId,
status:"pending",
reason:"Withdrawal requested",
timestamp:Date.now()
};

await db.ref(`users/${uid}/transactions/${id}`).set(data);
await db.ref(`users/${uid}/withdrawals/${id}`).set(data);

res.json({status:"PENDING",transactionId:id});

}catch(e){console.error(e);res.status(500).json({error:"Server"});}
});

/* ===============================
ADMIN WITHDRAW ACTION
=============================== */
app.post("/admin/withdrawal-action",verifyFirebaseToken,verifyAdmin,async(req,res)=>{
try{
const{userId,transactionId,action,reason,upiReference}=req.body;

const txnRef=db.ref(`users/${userId}/transactions/${transactionId}`);
const snap=await txnRef.once("value");
if(!snap.exists()) return res.status(404).json({error:"Not found"});

const txn=snap.val();
if(!validTransition("withdrawal",txn.status,action==="approve"?"success":"rejected"))
return res.status(400).json({error:"Invalid state"});

if(action==="approve"){
await txnRef.update({status:"success",upiReference,approvedBy:req.uid});
await db.ref(`users/${userId}/withdrawals/${transactionId}`).update({status:"success"});
return res.json({status:"APPROVED"});
}

if(action==="reject"){
await db.ref(`users/${userId}/wallet/winnings`).transaction(v=>(Number(v)||0)+Number(txn.amount));
await txnRef.update({status:"rejected",reason:reason||"Rejected",rejectedBy:req.uid});
await db.ref(`users/${userId}/withdrawals/${transactionId}`).update({status:"rejected",reason:reason||"Rejected"});
return res.json({status:"REJECTED"});
}

res.status(400).json({error:"Invalid action"});

}catch(e){console.error(e);res.status(500).json({error:"Server"});}
});

/* =============================== */
app.listen(process.env.PORT||3000,()=>console.log("Backend running"));
