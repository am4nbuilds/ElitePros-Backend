import admin from "firebase-admin";

const db = admin.database();

/* ================= TIME HELPERS ================= */

function isTimeToRun() {
  const now = new Date();
  return now.getHours() === 0 && now.getMinutes() === 1;
}

function isSunday() {
  return new Date().getDay() === 0;
}

function isFirstDayOfMonth() {
  return new Date().getDate() === 1;
}

/* ================= CORE PROCESSOR ================= */

async function processLeaderboard(type) {

  const ref = db.ref(`leaderboards/${type}`);

  /* 1️⃣ LOCK */
  const lockTxn = await ref.child("lock").transaction(val => {
    if (val === true) return;
    return true;
  });

  if (!lockTxn.committed) {
    console.log(`${type} already locked`);
    return;
  }

  try {

    /* 2️⃣ FREEZE LEADERBOARD */
    await ref.child("frozen").set(true);

    /* 3️⃣ FETCH TOP 10 */
    const playersSnap = await ref.child("players")
      .orderByChild("earnings")
      .limitToLast(10)
      .once("value");

    const rewardsSnap = await ref.child("rewards").once("value");
    const rewards = rewardsSnap.val() || {};

    const players = [];

    playersSnap.forEach(child => {
      players.push({
        uid: child.key,
        earnings: child.val().earnings
      });
    });

    players.reverse(); // highest first

    /* 4️⃣ DISTRIBUTE REWARDS */
    for (let i = 0; i < players.length; i++) {

      const rank = i + 1;
      const rewardAmount = Number(rewards[rank] || 0);
      if (rewardAmount <= 0) continue;

      const uid = players[i].uid;

      await db.ref(`users/${uid}/wallet/winnings`)
        .transaction(v => (Number(v) || 0) + rewardAmount);

      await db.ref(`users/${uid}/transactions/${type.toUpperCase()}_${Date.now()}_${rank}`)
        .set({
          type: "Leaderboard Reward",
          leaderboard: type,
          rank,
          amount: rewardAmount,
          status: "Success",
          timestamp: Date.now()
        });
    }

    /* 5️⃣ DELETE PLAYERS (RESET BOARD) */
    await ref.child("players").remove();

    /* 6️⃣ UNFREEZE + UNLOCK */
    await ref.update({
      frozen: false,
      lock: false
    });

    console.log(`${type} leaderboard processed successfully`);

  } catch (err) {

    await ref.update({
      frozen: false,
      lock: false
    });

    console.error(`${type} failed`, err);
  }
}

/* ================= MASTER CRON ================= */

export async function runCronJobs() {

  if (!isTimeToRun()) return;

  console.log("Cron triggered at 00:01");

  await processLeaderboard("today");

  if (isSunday()) {
    await processLeaderboard("weekly");
  }

  if (isFirstDayOfMonth()) {
    await processLeaderboard("monthly");
  }
        }
