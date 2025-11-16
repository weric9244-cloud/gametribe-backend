const crypto = require("crypto");
const { database } = require("../config/firebase");
const admin = require("firebase-admin");
const {
  ref,
  get,
  set,
  push,
  update,
  remove,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
} = require("firebase/database");
const {
  validateChallengeRequest,
} = require("../middleware/challengeValidator");
const {
  addChallengeToUserIndex,
  updateChallengeInUserIndex,
  removeChallengeFromUserIndex,
  getUserChallengeIds,
} = require("../utils/challengeIndexer");
const { createLogger } = require("../utils/logger");
const log = createLogger("challenges");
const {
  emitScoreUpdated,
  emitChallengeCompleted,
} = require("../services/socketService");
const {
  sendScoreUpdatedNotification,
  sendChallengeCompletedNotification,
} = require("../services/fcmService");

/**
 * Challenge Controller V2 - No Encryption
 * Optimized for real-time performance
 */

// Generate a secure challenge ID
const generateChallengeId = () => {
  return crypto.randomBytes(16).toString("hex");
};

/**
 * Create a new challenge (NO ENCRYPTION)
 */
const createChallenge = async (req, res) => {
  try {
    const {
      challengedId,
      gameId,
      gameTitle,
      gameImage,
      gameUrl,
      betAmount,
      message,
    } = req.body;
    const challengerId = req.user.uid;

    const rid =
      req.headers["x-request-id"] ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    log.info("create:start", {
      rid,
      challengerId,
      challengedId,
      gameId,
      betAmount,
    });

    // Validate required fields
    if (!challengedId || !gameId || !gameTitle || !betAmount) {
      return res.status(400).json({
        error:
          "Missing required fields: challengedId, gameId, gameTitle, betAmount",
      });
    }

    // Validate bet amount
    const bet = parseInt(betAmount);
    if (isNaN(bet) || bet < 10 || bet > 10000) {
      return res.status(400).json({
        error: "Bet amount must be between 10 and 10,000 KES",
      });
    }

    // Check if user is challenging themselves
    if (challengerId === challengedId) {
      return res.status(400).json({
        error: "Cannot challenge yourself",
      });
    }

    // DUPLICATE PREVENTION: Check for existing pending/accepted challenges between these users
    log.debug("create:duplicate_check:start", { rid });
    try {
      const existingChallengeIds = await getUserChallengeIds(
        challengerId,
        "pending"
      );

      // Check challenger's pending challenges
      for (const existingChallengeId of existingChallengeIds) {
        const existingChallengeRef = ref(
          database,
          `bettingChallenges/${existingChallengeId}`
        );
        const existingChallengeSnap = await get(existingChallengeRef);

        if (existingChallengeSnap.exists()) {
          const existingChallengeData = existingChallengeSnap.val();

          // Check if this is a challenge with the same opponent and game
          if (
            (existingChallengeData.challengerId === challengerId &&
              existingChallengeData.challengedId === challengedId) ||
            (existingChallengeData.challengerId === challengedId &&
              existingChallengeData.challengedId === challengerId)
          ) {
            if (
              existingChallengeData.gameId === gameId &&
              existingChallengeData.status === "pending"
            ) {
              return res.status(409).json({
                error:
                  "A pending challenge already exists with this opponent for this game",
                existingChallengeId: existingChallengeId,
              });
            }
          }
        }
      }

      // Also check challenger's accepted challenges
      const acceptedChallengeIds = await getUserChallengeIds(
        challengerId,
        "accepted"
      );

      for (const existingChallengeId of acceptedChallengeIds) {
        const existingChallengeRef = ref(
          database,
          `bettingChallenges/${existingChallengeId}`
        );
        const existingChallengeSnap = await get(existingChallengeRef);

        if (existingChallengeSnap.exists()) {
          const existingChallengeData = existingChallengeSnap.val();

          // Check if this is an accepted challenge with the same opponent
          if (
            (existingChallengeData.challengerId === challengerId &&
              existingChallengeData.challengedId === challengedId) ||
            (existingChallengeData.challengerId === challengedId &&
              existingChallengeData.challengedId === challengerId)
          ) {
            // Allow only if at least one player has submitted their score
            if (
              !existingChallengeData.challengerScore &&
              !existingChallengeData.challengedScore
            ) {
              return res.status(409).json({
                error:
                  "An active challenge already exists with this opponent. Please complete it first.",
                existingChallengeId: existingChallengeId,
              });
            }
          }
        }
      }

      log.info("create:duplicate_check:ok", { rid });
    } catch (duplicateCheckError) {
      log.warn("create:duplicate_check:error", {
        rid,
        error: duplicateCheckError.message,
      });
      // Continue with challenge creation even if duplicate check fails
    }

    // Check wallet balance and move to escrow
    const userRef = ref(database, `users/${challengerId}`);
    const userSnap = await get(userRef);
    const user = userSnap.val();

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const wallet = user.wallet || { amount: 0, escrowBalance: 0 };
    const currentBalance = wallet.amount || 0;
    const currentEscrow = wallet.escrowBalance || 0;

    log.info("create:wallet_check", {
      rid,
      challengerId,
      currentBalance,
      currentEscrow,
      totalBalance: currentBalance + currentEscrow,
      betAmount: bet,
      walletObject: wallet,
    });

    if (currentBalance < bet) {
      log.warn("create:insufficient_balance", {
        rid,
        challengerId,
        currentBalance,
        currentEscrow,
        totalBalance: currentBalance + currentEscrow,
        betAmount: bet,
        availableBalance: currentBalance,
        requiredBalance: bet,
      });
      return res.status(400).json({
        error: "Insufficient wallet balance",
        balance: currentBalance,
        escrowBalance: currentEscrow,
        totalBalance: currentBalance + currentEscrow,
        required: bet,
        message: `Available balance: ${currentBalance} KES, Required: ${bet} KES. ${currentEscrow > 0 ? `${currentEscrow} KES is currently in escrow.` : ''}`,
      });
    }

    // Generate challenge ID first (needed for transaction record)
    const challengeId = generateChallengeId();

    // Deduct from wallet and add to escrow
    const newBalance = currentBalance - bet;
    const newEscrow = currentEscrow + bet;

    await update(userRef, {
      "wallet/amount": newBalance,
      "wallet/escrowBalance": newEscrow,
      "wallet/updatedAt": new Date().toISOString(),
    });

    // Create transaction record directly (don't call addWalletTransaction as it would read stale balance)
    const transactionId = push(ref(database, `users/${challengerId}/wallet/transactions`)).key;
    const transaction = {
      id: transactionId,
      amount: -bet,
      type: "escrow",
      description: `Challenge escrow: ${challengeId}`,
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      metadata: { challengeId, type: "challenge_created" },
      createdAt: new Date().toISOString(),
    };

    await update(ref(database, `users/${challengerId}`), {
      [`wallet/transactions/${transactionId}`]: transaction,
    });

    // Create challenge data (NO ENCRYPTION)
    const challengeData = {
      challengeId,
      challengerId,
      challengedId,
      gameId,
      gameTitle,
      gameImage: gameImage || "",
      gameUrl: gameUrl || "",
      betAmount: bet,
      message: message || "",
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    };

    // Store betting challenge in separate path from chat challenges for security
    // Betting challenges (PAID) use 'bettingChallenges/' path
    const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
    await set(challengeRef, challengeData);

    // Emit realtime to both players IMMEDIATELY after DB write (before indexes)
    // This ensures UI updates instantly while DB operations continue in background
    const payload = {
      challengeId,
      challengerId,
      challengedId,
      gameId,
      gameTitle,
      gameImage: challengeData.gameImage,
      gameUrl: challengeData.gameUrl,
      betAmount: bet,
      message: challengeData.message,
      status: "pending",
      createdAt: challengeData.createdAt,
      expiresAt: challengeData.expiresAt,
    };
    
    try {
      const { emitChallengeCreated } = require("../services/socketService");
      emitChallengeCreated(challengerId, challengedId, payload);
    } catch (e) {
      log.warn("realtime_emit:create:warn", { error: e.message });
    }

    // Add to user indexes in background (non-blocking)
    addChallengeToUserIndex(
      challengeId,
      challengerId,
      challengedId,
      "pending"
    ).catch((err) => {
      log.warn("create:index_update:error", { error: err.message, challengeId });
    });

    // Create notification for challenged user (non-blocking)
    try {
      const { createChallengeNotification } = require("./notificationController");
      const challengerName = user.displayName || user.username || "Someone";
      const challengerAvatar = user.photoURL || user.avatar || "";
      
      createChallengeNotification(challengerId, challengedId, {
        challengeId,
        challengerName,
        challengerAvatar,
        gameTitle: challengeData.gameTitle,
        gameImage: challengeData.gameImage,
        betAmount: bet,
      }).catch((err) => {
        log.warn("create:notification:error", { error: err.message, challengeId });
      });
    } catch (notifyErr) {
      log.warn("create:notification:setup_error", { error: notifyErr.message });
    }

    log.info("create:success", {
      rid,
      challengeId,
      durationMs: Date.now() - started,
    });

    res.json({
      success: true,
      challengeId,
      message: "Challenge created successfully",
    });
  } catch (error) {
    log.error("create:error", { error: error.message });
    res.status(500).json({
      error: "Failed to create challenge",
      message: error.message,
    });
  }
};

/**
 * Accept a challenge (NO ENCRYPTION)
 */
const acceptChallenge = async (req, res) => {
  try {
    const { challengeId } = req.params;
    const challengedId = req.user.uid;
    const rid =
      req.headers["x-request-id"] ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    log.info("accept:start", { rid, challengeId, challengedId });

    // Get betting challenge data (separate path from chat challenges)
    const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
    const challengeSnap = await get(challengeRef);

    if (!challengeSnap.exists()) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const challengeData = challengeSnap.val();

    // Validate challenge
    if (challengeData.challengedId !== challengedId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (challengeData.status !== "pending") {
      return res.status(400).json({ error: "Challenge is not pending" });
    }

    if (Date.now() > challengeData.expiresAt) {
      return res.status(400).json({ error: "Challenge has expired" });
    }

    // Check wallet balance and move to escrow for challenged user
    const { addWalletTransaction } = require("../controllers/walletController");
    const challengedUserRef = ref(database, `users/${challengedId}`);
    const challengedUserSnap = await get(challengedUserRef);
    const challengedUser = challengedUserSnap.val();

    if (!challengedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const betAmount = challengeData.betAmount;
    const challengedWallet = challengedUser.wallet || { amount: 0, escrowBalance: 0 };
    const challengedBalance = challengedWallet.amount || 0;
    const challengedEscrow = challengedWallet.escrowBalance || 0;

    if (challengedBalance < betAmount) {
      return res.status(400).json({
        error: "Insufficient wallet balance",
        balance: challengedBalance,
        required: betAmount,
      });
    }

    // Store original values for rollback in case of error
    const originalBalance = challengedBalance;
    const originalEscrow = challengedEscrow;
    let acceptedAt;

    try {
      // Deduct from wallet and add to escrow for challenged user
      const newChallengedBalance = challengedBalance - betAmount;
      const newChallengedEscrow = challengedEscrow + betAmount;

      await update(challengedUserRef, {
        "wallet/amount": newChallengedBalance,
        "wallet/escrowBalance": newChallengedEscrow,
        "wallet/updatedAt": new Date().toISOString(),
      });

      // Add transaction record for challenged user (without updating balance again)
      // Create transaction record directly without calling addWalletTransaction
      // since we've already updated the wallet balance above
      const transactionId = push(ref(database, `users/${challengedId}/wallet/transactions`)).key;
      const transaction = {
        id: transactionId,
        amount: -betAmount,
        type: "escrow",
        description: `Challenge escrow: ${challengeId}`,
        balanceBefore: originalBalance,
        balanceAfter: newChallengedBalance,
        metadata: { challengeId, type: "challenge_accepted" },
        createdAt: new Date().toISOString(),
      };

      await update(ref(database, `users/${challengedId}`), {
        [`wallet/transactions/${transactionId}`]: transaction,
      });

      // Update challenge status - MUST complete before response
      acceptedAt = Date.now();
      await update(challengeRef, {
        status: "accepted",
        acceptedAt: acceptedAt,
      });
    } catch (error) {
      // Rollback wallet changes if challenge status update fails
      log.error("accept:rollback", { 
        rid, 
        challengeId, 
        error: error.message,
        originalBalance,
        originalEscrow 
      });
      
      try {
        await update(challengedUserRef, {
          "wallet/amount": originalBalance,
          "wallet/escrowBalance": originalEscrow,
          "wallet/updatedAt": new Date().toISOString(),
        });
        log.info("accept:rollback:success", { rid, challengeId });
      } catch (rollbackError) {
        log.error("accept:rollback:failed", { 
          rid, 
          challengeId, 
          error: rollbackError.message 
        });
      }
      
      throw error; // Re-throw to be caught by outer catch
    }

    // Emit accepted to both players IMMEDIATELY after DB update (before indexes)
    // This ensures UI updates instantly while index operations continue in background
    const payload = {
      challengeId,
      challengerId: challengeData.challengerId,
      challengedId: challengeData.challengedId,
      gameId: challengeData.gameId,
      gameTitle: challengeData.gameTitle,
      gameImage: challengeData.gameImage,
      gameUrl: challengeData.gameUrl,
      betAmount: challengeData.betAmount,
      status: "accepted",
      acceptedAt: acceptedAt,
    };
    
    try {
      const { emitChallengeAccepted } = require("../services/socketService");
      emitChallengeAccepted(
        challengeData.challengerId,
        challengeData.challengedId,
        payload
      );
    } catch (e) {
      log.warn("realtime_emit:accept:warn", { error: e.message });
    }

    // Update user indexes in background (non-blocking)
    updateChallengeInUserIndex(
      challengeId,
      challengeData.challengerId,
      challengeData.challengedId,
      "accepted"
    ).catch((err) => {
      log.warn("accept:index_update:error", { error: err.message, challengeId });
    });

    log.info("accept:success", {
      rid,
      challengeId,
      durationMs: Date.now() - started,
    });

    res.json({
      success: true,
      message: "Challenge accepted successfully",
    });
  } catch (error) {
    log.error("accept:error", { error: error.message });
    res.status(500).json({
      error: "Failed to accept challenge",
      message: error.message,
    });
  }
};

/**
 * Reject a challenge (NO ENCRYPTION)
 */
const rejectChallenge = async (req, res) => {
  try {
    const { challengeId } = req.params;
    const challengedId = req.user.uid;
    const rid =
      req.headers["x-request-id"] ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    log.info("reject:start", { rid, challengeId, challengedId });

    // Get betting challenge data (separate path from chat challenges)
    const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
    const challengeSnap = await get(challengeRef);

    if (!challengeSnap.exists()) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const challengeData = challengeSnap.val();

    // Validate challenge
    if (challengeData.challengedId !== challengedId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (challengeData.status !== "pending") {
      return res.status(400).json({ error: "Challenge is not pending" });
    }

    // Update challenge status
    await update(challengeRef, {
      status: "rejected",
      rejectedAt: Date.now(),
    });

    // Update user indexes
    await updateChallengeInUserIndex(
      challengeId,
      challengeData.challengerId,
      challengeData.challengedId,
      "rejected"
    );

    log.info("reject:success", {
      rid,
      challengeId,
      durationMs: Date.now() - started,
    });

    // Emit rejected to challenger
    try {
      const payload = {
        challengeId,
        challengerId: challengeData.challengerId,
        challengedId: challengeData.challengedId,
        gameId: challengeData.gameId,
        gameTitle: challengeData.gameTitle,
        betAmount: challengeData.betAmount,
        rejectedAt: Date.now(),
      };
      const { emitChallengeRejected } = require("../services/socketService");
      emitChallengeRejected(
        challengeData.challengerId,
        challengeData.challengedId,
        payload
      );
    } catch (e) {
      log.warn("realtime_emit:reject:warn", { error: e.message });
    }

    res.json({
      success: true,
      message: "Challenge rejected successfully",
    });
  } catch (error) {
    log.error("reject:error", { error: error.message });
    res.status(500).json({
      error: "Failed to reject challenge",
      message: error.message,
    });
  }
};

/**
 * Cancel a challenge (NO ENCRYPTION)
 */
const cancelChallenge = async (req, res) => {
  try {
    const { challengeId } = req.params;
    const challengerId = req.user.uid;
    const rid =
      req.headers["x-request-id"] ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    log.info("cancel:start", { rid, challengeId, challengerId });

    // Get betting challenge data (separate path from chat challenges)
    const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
    const challengeSnap = await get(challengeRef);

    if (!challengeSnap.exists()) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const challengeData = challengeSnap.val();

    // Validate challenge
    if (challengeData.challengerId !== challengerId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (challengeData.status !== "pending") {
      return res.status(400).json({ error: "Challenge is not pending" });
    }

    // Update challenge status
    await update(challengeRef, {
      status: "cancelled",
      cancelledAt: Date.now(),
    });

    // Update user indexes
    await updateChallengeInUserIndex(
      challengeId,
      challengeData.challengerId,
      challengeData.challengedId,
      "cancelled"
    );

    log.info("cancel:success", {
      rid,
      challengeId,
      durationMs: Date.now() - started,
    });

    // Emit cancelled to opponent
    try {
      const payload = {
        challengeId,
        challengerId: challengeData.challengerId,
        challengedId: challengeData.challengedId,
        gameId: challengeData.gameId,
        gameTitle: challengeData.gameTitle,
        betAmount: challengeData.betAmount,
        cancelledAt: Date.now(),
      };
      const { emitChallengeCancelled } = require("../services/socketService");
      emitChallengeCancelled(
        challengeData.challengerId,
        challengeData.challengedId,
        payload
      );
    } catch (e) {
      log.warn("realtime_emit:cancel:warn", { error: e.message });
    }

    res.json({
      success: true,
      message: "Challenge cancelled successfully",
    });
  } catch (error) {
    log.error("cancel:error", { error: error.message });
    res.status(500).json({
      error: "Failed to cancel challenge",
      message: error.message,
    });
  }
};

/**
 * Start a game session
 */
const startGameSession = async (req, res) => {
  try {
    const { challengeId } = req.body;
    const userId = req.user.uid;
    const rid =
      req.headers["x-request-id"] ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    log.info("session:start", { rid, challengeId, userId });

    // Validate challengeId
    if (!challengeId) {
      return res.status(400).json({ error: "Challenge ID is required" });
    }

    // Get betting challenge data (separate path from chat challenges)
    const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
    const challengeSnap = await get(challengeRef);

    if (!challengeSnap.exists()) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const challengeData = challengeSnap.val();

    // Validate challenge
    if (
      challengeData.challengerId !== userId &&
      challengeData.challengedId !== userId
    ) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (challengeData.status !== "accepted") {
      log.warn("session:invalid_status", {
        rid,
        challengeId,
        userId,
        currentStatus: challengeData.status,
        expectedStatus: "accepted",
      });
      return res.status(400).json({
        error: "Challenge is not accepted",
        currentStatus: challengeData.status,
        message:
          "Please ensure the challenge has been accepted before starting the game",
      });
    }

    log.info("session:challenge_validated", {
      rid,
      challengeId,
      userId,
      challengerId: challengeData.challengerId,
      challengedId: challengeData.challengedId,
    });

    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString("hex");

    // Store session token
    const sessionRef = ref(database, `gameSessions/${sessionToken}`);
    await set(sessionRef, {
      challengeId,
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
    });

    log.info("session:success", {
      rid,
      challengeId,
      sessionToken,
      durationMs: Date.now() - started,
    });

    res.json({
      success: true,
      sessionToken,
      message: "Game session started successfully",
    });
  } catch (error) {
    log.error("session:error", { error: error.message });
    res.status(500).json({
      error: "Failed to start game session",
      message: error.message,
    });
  }
};

/**
 * Submit challenge score (NO ENCRYPTION)
 */
const submitChallengeScore = async (req, res) => {
  try {
    const { challengeId, score, sessionToken } = req.body;
    const userId = req.user.uid;
    const rid =
      req.headers["x-request-id"] ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    log.info("score:start", { rid, challengeId, score, userId });

    // Validate session token
    const sessionRef = ref(database, `gameSessions/${sessionToken}`);
    const sessionSnap = await get(sessionRef);

    if (!sessionSnap.exists()) {
      log.warn("score:session_not_found", {
        rid,
        challengeId,
        sessionToken: sessionToken?.substring(0, 8) + "...",
        userId,
      });
      return res.status(403).json({
        error: "Invalid or expired game session",
        message: "Please restart the game to get a new session token",
      });
    }

    const sessionData = sessionSnap.val();
    if (
      sessionData.userId !== userId ||
      sessionData.challengeId !== challengeId
    ) {
      log.warn("score:session_mismatch", {
        rid,
        challengeId,
        userId,
        sessionUserId: sessionData.userId,
        sessionChallengeId: sessionData.challengeId,
      });
      return res.status(403).json({
        error: "Invalid session",
        message:
          "Session token does not match this challenge. Please restart the game.",
      });
    }

    if (Date.now() > sessionData.expiresAt) {
      log.warn("score:session_expired", {
        rid,
        challengeId,
        userId,
        expiresAt: sessionData.expiresAt,
        now: Date.now(),
      });
      return res.status(403).json({
        error: "Session expired",
        message: "Game session has expired. Please restart the game.",
      });
    }

    log.info("score:session_validated", {
      rid,
      challengeId,
      userId,
      sessionAge: Date.now() - sessionData.createdAt,
    });

    // Get betting challenge data (separate path from chat challenges)
    const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
    const challengeSnap = await get(challengeRef);

    if (!challengeSnap.exists()) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const challengeData = challengeSnap.val();

    // Validate challenge
    if (
      challengeData.challengerId !== userId &&
      challengeData.challengedId !== userId
    ) {
      log.warn("score:unauthorized", {
        rid,
        challengeId,
        userId,
        challengerId: challengeData.challengerId,
        challengedId: challengeData.challengedId,
      });
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (challengeData.status !== "accepted") {
      log.warn("score:invalid_status", {
        rid,
        challengeId,
        userId,
        currentStatus: challengeData.status,
        expectedStatus: "accepted",
      });
      return res.status(400).json({
        error: "Challenge is not accepted",
        currentStatus: challengeData.status,
        message: "Please ensure the challenge has been accepted before starting the game",
      });
    }

    log.info("score:challenge_validated", {
      rid,
      challengeId,
      userId,
      currentScores: {
        challenger: challengeData.challengerScore,
        challenged: challengeData.challengedScore,
      },
    });

    // Update challenge with score
    const updates = {};
    const isChallenger = challengeData.challengerId === userId;
    if (isChallenger) {
      updates.challengerScore = score;
      log.info("score:updating_challenger", {
        rid,
        challengeId,
        userId,
        score,
        previousScore: challengeData.challengerScore,
      });
    } else {
      updates.challengedScore = score;
      log.info("score:updating_challenged", {
        rid,
        challengeId,
        userId,
        score,
        previousScore: challengeData.challengedScore,
      });
    }

    // Check if both scores are submitted
    const newChallengerScore =
      updates.challengerScore ?? challengeData.challengerScore;
    const newChallengedScore =
      updates.challengedScore ?? challengeData.challengedScore;

    if (newChallengerScore != null && newChallengedScore != null) {
      updates.status = "completed";
      updates.completedAt = Date.now();

      // Determine winner
      if (newChallengerScore > newChallengedScore) {
        updates.winnerId = challengeData.challengerId;
      } else if (newChallengedScore > newChallengerScore) {
        updates.winnerId = challengeData.challengedId;
      } else {
        updates.winnerId = "tie";
      }

      log.info("score:challenge_completing", {
        rid,
        challengeId,
        finalScores: {
          challenger: newChallengerScore,
          challenged: newChallengedScore,
        },
        winnerId: updates.winnerId,
      });
    } else {
      log.info("score:partial_submission", {
        rid,
        challengeId,
        challengerScore: newChallengerScore,
        challengedScore: newChallengedScore,
        waitingFor: newChallengerScore == null ? "challenger" : "challenged",
      });
    }

    // Update challenge data
    log.info("score:updating_database", {
      rid,
      challengeId,
      updates,
    });
    await update(challengeRef, updates);
    log.info("score:database_updated", {
      rid,
      challengeId,
      updatesApplied: Object.keys(updates),
    });

    // Update user indexes for status change
    if (updates.status === "completed") {
      log.info("score:updating_indexes", {
        rid,
        challengeId,
        challengerId: challengeData.challengerId,
        challengedId: challengeData.challengedId,
        newStatus: "completed",
      });
      await updateChallengeInUserIndex(
        challengeId,
        challengeData.challengerId,
        challengeData.challengedId,
        "completed"
      );
      log.info("score:indexes_updated", { rid, challengeId });
    }

    // Remove session token
    log.info("score:removing_session", {
      rid,
      challengeId,
      sessionToken: sessionToken?.substring(0, 8) + "...",
    });
    await remove(sessionRef);

    log.info("score:success", {
      rid,
      challengeId,
      score,
      newStatus: updates.status,
      durationMs: Date.now() - started,
    });

    // Emit real-time updates
    try {
      const opponentId =
        challengeData.challengerId === userId
          ? challengeData.challengedId
          : challengeData.challengerId;

      const scorePayload = {
        challengerScore:
          updates.challengerScore ?? challengeData.challengerScore,
        challengedScore:
          updates.challengedScore ?? challengeData.challengedScore,
        isComplete: updates.status === "completed",
        winnerId: updates.winnerId,
      };

      log.info("score:emitting_realtime", {
        rid,
        challengeId,
        userId,
        opponentId,
        payload: scorePayload,
      });

      emitScoreUpdated(userId, opponentId, challengeId, scorePayload);

      // Send FCM for score update if not yet completed
      if (updates.status !== "completed") {
        sendScoreUpdatedNotification(opponentId, userId, {
          ...challengeData,
          challengerScore:
            updates.challengerScore ?? challengeData.challengerScore,
          challengedScore:
            updates.challengedScore ?? challengeData.challengedScore,
        }).catch((err) =>
          log.error("FCM score notification failed", { error: err.message })
        );
      }

      // If challenge completed, emit completion + FCM to both players
      if (updates.status === "completed") {
        const completionPayload = {
          ...challengeData,
          challengerScore:
            updates.challengerScore ?? challengeData.challengerScore,
          challengedScore:
            updates.challengedScore ?? challengeData.challengedScore,
          winnerId: updates.winnerId,
          completedAt: updates.completedAt,
        };
        emitChallengeCompleted(
          challengeData.challengerId,
          challengeData.challengedId,
          completionPayload
        );

        // Notify both participants
        const a = sendChallengeCompletedNotification(
          challengeData.challengerId,
          challengeData.challengedId,
          completionPayload
        ).catch((err) =>
          log.error("FCM completion notify (challenger) failed", {
            error: err.message,
          })
        );
        const b = sendChallengeCompletedNotification(
          challengeData.challengedId,
          challengeData.challengerId,
          completionPayload
        ).catch((err) =>
          log.error("FCM completion notify (challenged) failed", {
            error: err.message,
          })
        );
        await Promise.allSettled([a, b]);
      }
    } catch (emitErr) {
      log.error("realtime_emit:error", { error: emitErr.message });
    }

    res.json({ success: true, message: "Score submitted successfully" });
  } catch (error) {
    log.error("score:error", { error: error.message });
    res.status(500).json({
      error: "Failed to submit score",
      message: error.message,
    });
  }
};

/**
 * Get challenge history (NO ENCRYPTION - OPTIMIZED)
 */
const getChallengeHistory = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { limit = 10, offset = 0, status } = req.query;

    const rid =
      req.headers["x-request-id"] ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();
    log.info("history:start", {
      rid,
      userId,
      status: status || "all",
      limit,
      offset,
    });

    // Get user's challenge IDs from index
    const idsStartTime = Date.now();
    const challengeIds = await getUserChallengeIds(userId, status);
    log.info("history:ids", {
      rid,
      count: challengeIds.length,
      durationMs: Date.now() - idsStartTime,
    });

    // Only decrypt challenges we need
    const challengesToFetch = challengeIds.slice(
      parseInt(offset),
      parseInt(offset) + parseInt(limit)
    );

    log.info("history:fetching_challenges", {
      rid,
      totalIds: challengeIds.length,
      fetchingCount: challengesToFetch.length,
      offset: parseInt(offset),
      limit: parseInt(limit),
    });

    const userChallenges = [];
    const uniqueUserIds = new Set();
    const fetchStartTime = Date.now();

    // Fetch challenges in parallel with timeouts
    const challengePromises = challengesToFetch.map(async (challengeId) => {
      const challengeFetchStart = Date.now();
      try {
        const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
        
        // Add timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Challenge fetch timeout")), 5000)
        );
        
        const challengeSnap = await Promise.race([get(challengeRef), timeoutPromise]);

        if (!challengeSnap || !challengeSnap.exists()) {
          log.debug("history:challenge_not_found", {
            rid,
            challengeId,
            durationMs: Date.now() - challengeFetchStart,
          });
          return null;
        }

        const challengeData = challengeSnap.val();

        // Fetch interactions separately (they may not be in the main snapshot)
        let interactionsData = null;
        try {
          const interactionsRef = ref(database, `bettingChallenges/${challengeId}/interactions`);
          const interactionsSnap = await get(interactionsRef);
          if (interactionsSnap.exists()) {
            interactionsData = interactionsSnap.val();
          }
        } catch (interactionsError) {
          log.debug("history:interactions_fetch_failed", {
            rid,
            challengeId,
            error: interactionsError.message,
          });
        }

        // Debug logging to see what data is available
        const interactionsCount = interactionsData && typeof interactionsData === "object" 
          ? Object.keys(interactionsData).length 
          : 0;
        
        // Only log detailed data for challenges with interactions (to reduce log volume)
        if (interactionsCount > 0 || (challengeData.messages && Object.keys(challengeData.messages).length > 0) || 
            (challengeData.reactions && Object.keys(challengeData.reactions).length > 0)) {
          log.info("history:challenge_data_fetched", {
            rid,
            challengeId,
            status: challengeData.status,
            hasInteractions: !!interactionsData,
            interactionsCount: interactionsCount,
            hasMessages: !!challengeData.messages,
            messagesCount: challengeData.messages && typeof challengeData.messages === "object"
              ? Object.keys(challengeData.messages).length
              : 0,
            hasReactions: !!challengeData.reactions,
            reactionsCount: challengeData.reactions && typeof challengeData.reactions === "object"
              ? Object.keys(challengeData.reactions).length
              : 0,
          });
        }

        const reactionMap = {};
        
        // Build reactions from interactions first
        if (interactionsData && typeof interactionsData === "object") {
          Object.values(interactionsData).forEach((interaction) => {
            if (interaction && typeof interaction === "object" && 
                interaction.type === "reaction" && interaction.action === "added") {
              const emoji = interaction.reaction;
              if (!reactionMap[emoji]) {
                reactionMap[emoji] = [];
              }
              const exists = reactionMap[emoji].some(
                (r) => r.userId === interaction.userId && r.timestamp === interaction.timestamp
              );
              if (!exists) {
                reactionMap[emoji].push({
                  userId: interaction.userId || "",
                  userName: interaction.userName || "",
                  userAvatar: interaction.userAvatar || "",
                  timestamp: interaction.timestamp || null,
                });
              }
            }
          });
        }
        
        // Also include reactions from the old reactions path for backward compatibility
        if (challengeData.reactions && typeof challengeData.reactions === "object") {
          Object.entries(challengeData.reactions).forEach(([emoji, entries]) => {
            if (!reactionMap[emoji]) {
              reactionMap[emoji] = [];
            }
            const entryList = Array.isArray(entries) ? entries : Object.values(entries);
            entryList.forEach((entry) => {
              if (entry && typeof entry === "object") {
                const exists = reactionMap[emoji].some(
                  (r) => r.userId === entry.userId && r.timestamp === entry.timestamp
                );
                if (!exists) {
                  reactionMap[emoji].push({
                    userId: entry.userId || "",
                    userName: entry.userName || "",
                    userAvatar: entry.userAvatar || "",
                    timestamp: entry.timestamp || null,
                  });
                }
              }
            });
          });
        }

        const messagesArray = [];
        
        // Build messages from interactions first
        if (interactionsData && typeof interactionsData === "object") {
          Object.entries(interactionsData).forEach(([interactionId, value]) => {
            if (value && typeof value === "object" && value.type === "message") {
              const existing = messagesArray.find(
                (msg) => msg.messageId === (value.interactionId || value.messageId || interactionId)
              );
              if (!existing) {
                messagesArray.push({
                  messageId: value.interactionId || value.messageId || interactionId,
                  userId: value.userId || "",
                  userName: value.userName || "",
                  userAvatar: value.userAvatar || "",
                  message: value.message || "",
                  timestamp: value.timestamp || null,
                });
              }
            }
          });
        }
        
        // Fallback to messages path for backward compatibility
        if (challengeData.messages && typeof challengeData.messages === "object") {
          Object.entries(challengeData.messages).forEach(([messageId, value]) => {
            if (value && typeof value === "object") {
              const existing = messagesArray.find(
                (msg) => msg.messageId === (value.messageId || messageId)
              );
              if (!existing) {
                messagesArray.push({
                  messageId: value.messageId || messageId,
                  userId: value.userId || "",
                  userName: value.userName || "",
                  userAvatar: value.userAvatar || "",
                  message: value.message || "",
                  timestamp: value.timestamp || null,
                });
              }
            }
          });
        }

        messagesArray.sort(
          (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
        );

        const trimmedMessages =
          messagesArray.length > 50
            ? messagesArray.slice(messagesArray.length - 50)
            : messagesArray;

        // Log summary of messages and reactions found
        const reactionEmojiCount = Object.keys(reactionMap).length;
        const totalReactions = Object.values(reactionMap).reduce(
          (sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0),
          0
        );
        
        // Only log summary for challenges with actual interactions (to reduce log volume)
        if (trimmedMessages.length > 0 || totalReactions > 0) {
          log.info("history:challenge_interactions_summary", {
            rid,
            challengeId,
            messagesCount: trimmedMessages.length,
            totalMessagesFound: messagesArray.length,
            reactionEmojiTypes: reactionEmojiCount,
            totalReactions: totalReactions,
            reactionEmojis: Object.keys(reactionMap),
          });
        }

        // Store minimal challenge data
        return {
          challengeId: challengeData.challengeId,
          challengerId: challengeData.challengerId,
          challengedId: challengeData.challengedId,
          gameId: challengeData.gameId,
          gameTitle: challengeData.gameTitle,
          gameImage: challengeData.gameImage,
          gameUrl: challengeData.gameUrl,
          betAmount: challengeData.betAmount,
          status: challengeData.status,
          createdAt: challengeData.createdAt,
          completedAt: challengeData.completedAt,
          winnerId: challengeData.winnerId,
          challengerScore: challengeData.challengerScore,
          challengedScore: challengeData.challengedScore,
          isChallenger: challengeData.challengerId === userId,
          opponentId:
            challengeData.challengerId === userId
              ? challengeData.challengedId
              : challengeData.challengerId,
          reactions: reactionMap,
          messages: trimmedMessages,
        };
      } catch (fetchError) {
        log.warn("history:challenge_fetch_failed", {
          rid,
          challengeId,
          error: fetchError.message,
          durationMs: Date.now() - challengeFetchStart,
        });
        return null;
      }
    });

    const challengeResults = await Promise.all(challengePromises);
    // Filter out null results and collect user IDs
    challengeResults.forEach((challenge) => {
      if (challenge) {
        userChallenges.push(challenge);
        uniqueUserIds.add(challenge.challengerId);
        uniqueUserIds.add(challenge.challengedId);
        (challenge.messages || []).forEach((message) => {
          if (message.userId) {
            uniqueUserIds.add(message.userId);
          }
        });
      }
    });

    // Calculate overall statistics
    let totalMessages = 0;
    let totalReactions = 0;
    let challengesWithMessages = 0;
    let challengesWithReactions = 0;
    
    userChallenges.forEach((challenge) => {
      const msgCount = challenge.messages?.length || 0;
      const reactCount = challenge.reactions 
        ? Object.values(challenge.reactions).reduce(
            (sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0),
            0
          )
        : 0;
      
      if (msgCount > 0) {
        challengesWithMessages++;
        totalMessages += msgCount;
      }
      if (reactCount > 0) {
        challengesWithReactions++;
        totalReactions += reactCount;
      }
    });

    log.info("history:challenges_fetched", {
      rid,
      fetchedCount: userChallenges.length,
      uniqueUsers: uniqueUserIds.size,
      challengesWithMessages,
      totalMessages,
      challengesWithReactions,
      totalReactions,
      durationMs: Date.now() - fetchStartTime,
    });

    // Batch fetch user data
    const userDataMap = {};
    const userFetchStartTime = Date.now();
    if (uniqueUserIds.size > 0) {
      log.info("history:fetching_users", {
        rid,
        userCount: uniqueUserIds.size,
        userIds: Array.from(uniqueUserIds),
      });
      const userPromises = Array.from(uniqueUserIds).map(async (uid) => {
        const userFetchStart = Date.now();
        try {
          const userRef = ref(database, `users/${uid}`);
          
          // Add timeout to prevent hanging
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("User fetch timeout")), 5000)
          );
          
          const userSnap = await Promise.race([get(userRef), timeoutPromise]);
          
          if (userSnap && userSnap.exists()) {
            const userData = userSnap.val();
            userDataMap[uid] = {
              displayName:
                userData.displayName || userData.username || "Unknown Player",
              photoURL: userData.photoURL || userData.avatar || "",
            };
            log.debug("history:user_fetched", {
              rid,
              userId: uid,
              durationMs: Date.now() - userFetchStart,
            });
          } else {
            log.debug("history:user_not_found", {
              rid,
              userId: uid,
              durationMs: Date.now() - userFetchStart,
            });
          }
        } catch (error) {
          log.warn("history:user_fetch_failed", {
            rid,
            userId: uid,
            error: error.message,
            durationMs: Date.now() - userFetchStart,
          });
        }
      });
      await Promise.all(userPromises);
      log.info("history:users_fetched", {
        rid,
        fetchedCount: Object.keys(userDataMap).length,
        durationMs: Date.now() - userFetchStartTime,
      });
    } else {
      log.info("history:no_users_to_fetch", { rid });
    }

    log.info("history:users_enriched", {
      rid,
      users: Object.keys(userDataMap).length,
      fetchMs: Date.now() - userFetchStartTime,
    });

    // Enrich challenges with user data
    const enrichedChallenges = userChallenges.map((challenge) => {
      const challengerData = userDataMap[challenge.challengerId] || {};
      const challengedData = userDataMap[challenge.challengedId] || {};

      return {
        ...challenge,
        challengerName: challengerData.displayName || "Unknown Player",
        challengedName: challengedData.displayName || "Unknown Player",
        challengerAvatar: challengerData.photoURL || "",
        challengedAvatar: challengedData.photoURL || "",
      };
    });

    const elapsed = Date.now() - startTime;
    log.info("history:success", {
      rid,
      items: enrichedChallenges.length,
      tookMs: elapsed,
    });

    return res.json({
      success: true,
      data: enrichedChallenges,
      total: challengeIds.length,
      hasMore: challengeIds.length > parseInt(offset) + parseInt(limit),
    });
  } catch (error) {
    log.error("history:error", { error: error.message });
    return res.status(500).json({
      error: "Failed to get challenge history",
      message: error.message,
    });
  }
};

/**
 * Get single challenge details (NO ENCRYPTION)
 */
const getChallengeDetails = async (req, res) => {
  try {
    const { challengeId } = req.params;
    const userId = req.user.uid;

    const challengeRef = ref(database, `bettingChallenges/${challengeId}`);
    const challengeSnap = await get(challengeRef);

    if (!challengeSnap.exists()) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const challengeData = challengeSnap.val();

    // Validate authorization
    if (
      challengeData.challengerId !== userId &&
      challengeData.challengedId !== userId
    ) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Fetch user data for both players
    const uniqueUserIds = new Set([
      challengeData.challengerId,
      challengeData.challengedId,
    ]);
    const userDataMap = {};

    for (const uid of uniqueUserIds) {
      try {
        const userRef = ref(database, `users/${uid}`);
        const userSnap = await get(userRef);
        if (userSnap.exists()) {
          const userData = userSnap.val();
          userDataMap[uid] = {
            displayName:
              userData.displayName || userData.username || "Unknown Player",
            photoURL: userData.photoURL || userData.avatar || "",
          };
        }
      } catch (error) {
        console.warn(`Failed to fetch user data for ${uid}:`, error.message);
      }
    }

    // Enrich challenge with user data
    const enrichedChallenge = {
      ...challengeData,
      challengerName:
        userDataMap[challengeData.challengerId]?.displayName ||
        "Unknown Player",
      challengedName:
        userDataMap[challengeData.challengedId]?.displayName ||
        "Unknown Player",
      challengerAvatar: userDataMap[challengeData.challengerId]?.photoURL || "",
      challengedAvatar: userDataMap[challengeData.challengedId]?.photoURL || "",
    };

    res.json({
      success: true,
      challenge: enrichedChallenge,
    });
  } catch (error) {
    log.error("details:error", { error: error.message });
    res.status(500).json({
      error: "Failed to get challenge details",
      message: error.message,
    });
  }
};

module.exports = {
  createChallenge,
  acceptChallenge,
  rejectChallenge,
  cancelChallenge,
  startGameSession,
  submitChallengeScore,
  getChallengeHistory,
  getChallengeDetails,
};
