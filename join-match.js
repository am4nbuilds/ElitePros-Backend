/* ======================================================
JOIN MATCH (RACE CONDITION SAFE)
====================================================== */

app.post("/join-match", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { matchId, ign } = req.body;

    if (!matchId || !ign) {
      return res.json({ error: "INVALID_DATA" });
    }

    let finalError = null;
    let committed = false;

    const txn = await db.ref().transaction((root) => {
      if (!root) return root;

      const match = root.matches?.upcoming?.[matchId];
      const user = root.users?.[uid];

      /* ======================================================
      VALIDATIONS (All must be inside transaction)
      ====================================================== */

      if (!match) {
        finalError = "MATCH_NOT_FOUND";
        return; // 🔴 abort
      }

      if (!user) {
        finalError = "USER_NOT_FOUND";
        return;
      }

      // Initialize players object if needed
      if (!match.players) match.players = {};

      // Check if already joined
      if (match.players[uid]) {
        finalError = "ALREADY_JOINED";
        return;
      }

      const slots = Number(match.slots || 100);
      const currentPlayers = Object.keys(match.players).length;

      // CRITICAL: Check capacity BEFORE any modifications
      if (currentPlayers >= slots) {
        finalError = "MATCH_FULL";
        return; // 🔴 critical abort - race condition protected
      }

      /* ======================================================
      WALLET CHECK (Must use current values)
      ====================================================== */

      let dep = Number(user.wallet?.deposited || 0);
      let win = Number(user.wallet?.winnings || 0);
      const entryFee = Number(match.matchDetails?.entryFee || 0);

      if (dep + win < entryFee) {
        finalError = "INSUFFICIENT_BALANCE";
        return;
      }

      /* ======================================================
      DEDUCTION LOGIC
      ====================================================== */

      let depositUsed = 0;
      let winningsUsed = 0;

      if (dep >= entryFee) {
        depositUsed = entryFee;
        dep -= entryFee;
      } else {
        depositUsed = dep;
        winningsUsed = entryFee - dep;
        dep = 0;
        win -= winningsUsed;
      }

      /* ======================================================
      APPLY UPDATES (ATOMIC)
      ====================================================== */

      // wallet update
      if (!root.users[uid].wallet) root.users[uid].wallet = {};
      root.users[uid].wallet.deposited = dep;
      root.users[uid].wallet.winnings = win;

      // add player
      match.players[uid] = {
        ign,
        depositUsed,
        winningsUsed,
        joinedAt: Date.now()
      };

      // joined count - use current players + 1 for accuracy
      match.joinedCount = currentPlayers + 1;

      // myMatches
      if (!root.users[uid].myMatches) root.users[uid].myMatches = {};
      root.users[uid].myMatches[matchId] = {
        joinedAt: Date.now()
      };

      // save IGN globally
      root.users[uid].ign = ign;

      // transaction log
      const publicMatchId = match.matchDetails?.matchId || matchId;

      if (!root.users[uid].transactions) root.users[uid].transactions = {};
      root.users[uid].transactions[`${publicMatchId}_${uid}_${Date.now()}`] = {
        transactionId: `${publicMatchId}_Join`,
        type: "entry",
        amount: -entryFee,
        status: "success",
        reason: "Match Joined",
        timestamp: Date.now(),
        matchId: matchId,
        userId: uid
      };

      return root; // ✅ commit
    });

    /* ======================================================
    FINAL RESPONSE
    ====================================================== */

    if (!txn.committed) {
      // If transaction wasn't committed, there was a conflict
      // Return the specific error or a generic one
      return res.json({ 
        error: finalError || "JOIN_FAILED_TRANSACTION_CONFLICT" 
      });
    }

    return res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("JOIN ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});
