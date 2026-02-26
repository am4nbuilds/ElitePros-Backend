import admin from "firebase-admin";
import { runCronJobs } from "./services/leaderboardCron.js";

/* ================= FIREBASE INIT ================= */

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g,"\n")
  }),
  databaseURL: process.env.FB_DB_URL
});

console.log("Leaderboard Cron Service Started");

/* ================= RUN EVERY MINUTE ================= */

setInterval(async () => {
  await runCronJobs();
}, 60000);
