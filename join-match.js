app.post("/join-match", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { matchId, ign } = req.body;

    if (!matchId || !ign) return res.json({ error: "INVALID_DATA" });

    // 1. Point exactly to the match path used in your original logic
    const matchRef = db.ref(`matches/upcoming/${matchId}`);
    
    let errorCode = null;
    let transactionData = null;

    // 2. TRANSACTION ON THE MATCH NODE ONLY (Race-condition safe)
    const txn = await matchRef.transaction((match) => {
      if (match === null) {
        errorCode = "MATCH_NOT_FOUND";
        return; // Abort
      }

      // Check slots
      const players = match.players || {};
      const currentCount = Object.keys(players).length;
      const maxSlots = Number(match.slots || 100);

      if (currentCount >= maxSlots) {
        errorCode = "MATCH_FULL";
        return; 
      }

      if (players[uid]) {
        errorCode = "ALREADY_JOINED";
        return;
      }

      // Secure the slot temporarily (we'll finalize the update at the end of this block)
      if (!match.players) match.players = {};
      
      // We return the match object to "lock" this slot in Firebase
      transactionData = {
        entryFee: Number(match.matchDetails?.entryFee || 0),
        publicMatchId: match.matchDetails?.matchId || matchId
      };

      // We do NOT update the player here yet because we need to check the wallet first.
      // However, Firebase transactions are atomic. We will add the player now:
      match.players[uid] = { 
        ign, 
        joinedAt: Date.now() 
      };
      match.joinedCount = (match.joinedCount || 0) + 1;

      return match;
    });

    if (!txn.committed) {
      return res.json({ error: errorCode || "JOIN_FAILED" });
    }

    // 3. SECURE WALLET DEDUCTION (After Slot is Secured)
    const userRef = db.ref(`users/${uid}`);
    const userSnap = await userRef.once("value");
    const user = userSnap.val();

    if (!user) return res.json({ error: "USER_NOT_FOUND" });

    let dep = Number(user.wallet?.deposited || 0);
    let win = Number(user.wallet?.winnings || 0);
    const { entryFee, publicMatchId } = transactionData;

    if (dep + win < entryFee) {
      // OOPS: They got the slot but have no money. 
      // Rollback the match slot we just took!
      await matchRef.child(`players/${uid}`).remove();
      await matchRef.child("joinedCount").transaction(c => (c || 1) - 1);
      return res.json({ error: "INSUFFICIENT_BALANCE" });
    }

    // 4. PERFORM ATOMIC UPDATE ON USER
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

    const updates = {};
    updates[`users/${uid}/wallet/deposited`] = dep;
    updates[`users/${uid}/wallet/winnings`] = win;
    updates[`users/${uid}/myMatches/${matchId}`] = { joinedAt: Date.now() };
    updates[`users/${uid}/ign`] = ign;
    updates[`users/${uid}/transactions/${publicMatchId}_Join`] = {
      transactionId: `${publicMatchId}_Join`,
      type: "entry",
      amount: -entryFee,
      status: "success",
      reason: "Match Joined",
      timestamp: Date.now()
    };

    await db.ref().update(updates);

    return res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("JOIN ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});
