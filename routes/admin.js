const express = require("express");
const router = express.Router();
// Lazy load admin to avoid initialization delays
let admin = null;
const getAdmin = () => {
  if (!admin) {
    const firebaseConfig = require("../config/firebase");
    admin = firebaseConfig.admin;
  }
  return admin;
};

// Admin middleware (you should add proper authentication here)
const adminAuth = (req, res, next) => {
  const adminKey = req.headers["x-admin-key"];
  if (
    adminKey === process.env.ADMIN_SECRET_KEY ||
    adminKey === "temp-admin-key-2025"
  ) {
    next();
  } else {
    res.status(403).json({ error: "Unauthorized" });
  }
};

// Password-protected middleware for wallet updates (testing phase)
const walletUpdateAuth = (req, res, next) => {
  const password = req.body.password || req.query.password || req.headers["x-admin-password"];
  const ADMIN_PASSWORD = "AdminX2025"; // Hardcoded for testing phase
  
  if (password === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).json({ 
      error: "Unauthorized", 
      message: "Invalid admin password" 
    });
  }
};

// Sync user wallet from database to Firebase
router.post("/sync-wallet/:userId", adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, escrowBalance, currency } = req.body;

    if (!amount && amount !== 0) {
      return res.status(400).json({ error: "Amount is required" });
    }

    const walletData = {
      amount: parseInt(amount) || 0,
      escrowBalance: parseInt(escrowBalance) || 0,
      currency: currency || "KES",
      lastUpdated: Date.now(),
    };

    const admin = getAdmin();
    await admin.database().ref(`users/${userId}/wallet`).set(walletData);

    res.json({
      success: true,
      message: "Wallet synced successfully",
      userId,
      wallet: walletData,
    });
  } catch (error) {
    console.error("Error syncing wallet:", error);
    res.status(500).json({ error: error.message });
  }
});

// Batch sync multiple wallets
router.post("/sync-wallets-batch", adminAuth, async (req, res) => {
  try {
    const { wallets } = req.body; // Array of {userId, amount, escrowBalance, currency}

    if (!Array.isArray(wallets)) {
      return res.status(400).json({ error: "Wallets must be an array" });
    }

    const results = [];
    const admin = getAdmin();

    for (const wallet of wallets) {
      try {
        const walletData = {
          amount: parseInt(wallet.amount) || 0,
          escrowBalance: parseInt(wallet.escrowBalance) || 0,
          currency: wallet.currency || "KES",
          lastUpdated: Date.now(),
        };

        await admin
          .database()
          .ref(`users/${wallet.userId}/wallet`)
          .set(walletData);

        results.push({
          userId: wallet.userId,
          success: true,
          wallet: walletData,
        });
      } catch (error) {
        results.push({
          userId: wallet.userId,
          success: false,
          error: error.message,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;

    res.json({
      success: true,
      message: `Synced ${successCount} of ${wallets.length} wallets`,
      results,
    });
  } catch (error) {
    console.error("Error in batch sync:", error);
    res.status(500).json({ error: error.message });
  }
});

// Search for users by name or email and update wallet balance
router.post("/wallet/update", walletUpdateAuth, async (req, res) => {
  try {
    const { searchQuery, balance } = req.body;
    
    if (!searchQuery || searchQuery.trim() === "") {
      return res.status(400).json({ 
        error: "Search query is required",
        message: "Please provide a user name or email to search for"
      });
    }
    
    if (balance === undefined || balance === null || isNaN(parseFloat(balance))) {
      return res.status(400).json({ 
        error: "Balance is required",
        message: "Please provide a valid wallet balance"
      });
    }
    
    const newBalance = parseFloat(balance);
    const searchTerm = searchQuery.trim().toLowerCase();
    
    console.log(`[Admin] Searching for user: "${searchTerm}" to update balance to ${newBalance}`);
    
    // Get database reference
    const { database } = require("../config/firebase");
    const { ref, get, update } = require("firebase/database");
    const usersRef = ref(database, "users");
    const usersSnapshot = await get(usersRef);
    
    if (!usersSnapshot.exists()) {
      return res.status(404).json({ 
        error: "No users found",
        message: "Database is empty"
      });
    }
    
    const users = usersSnapshot.val();
    let foundUser = null;
    let foundUserId = null;
    
    // Search through all users
    for (const [userId, userData] of Object.entries(users)) {
      if (!userData) continue;
      
      // Check email
      const email = (userData.email || "").toLowerCase();
      // Check displayName
      const displayName = (userData.displayName || "").toLowerCase();
      // Check name
      const name = (userData.name || "").toLowerCase();
      // Check username
      const username = (userData.username || "").toLowerCase();
      
      // Match if search term is found in any of these fields
      if (
        email.includes(searchTerm) ||
        displayName.includes(searchTerm) ||
        name.includes(searchTerm) ||
        username.includes(searchTerm)
      ) {
        foundUser = userData;
        foundUserId = userId;
        break; // Take the first match
      }
    }
    
    if (!foundUser) {
      return res.status(404).json({ 
        error: "User not found",
        message: `No user found matching "${searchQuery}"`
      });
    }
    
    // Get current wallet balance
    const currentBalance = foundUser.wallet?.amount || 0;
    const currentEscrow = foundUser.wallet?.escrowBalance || 0;
    
    // Prepare wallet update
    const walletUpdate = {
      amount: newBalance,
      escrowBalance: currentEscrow, // Preserve escrow balance
      updatedAt: new Date().toISOString(),
      currency: foundUser.wallet?.currency || "KES",
    };
    
    // Preserve createdAt if it exists
    if (foundUser.wallet?.createdAt) {
      walletUpdate.createdAt = foundUser.wallet.createdAt;
    } else {
      walletUpdate.createdAt = new Date().toISOString();
    }
    
    // Create a transaction record for audit
    const transaction = {
      id: `admin_update_${Date.now()}`,
      amount: newBalance - currentBalance, // Difference
      type: newBalance > currentBalance ? "credit" : "debit",
      description: `Admin wallet balance update: ${currentBalance} → ${newBalance} KES`,
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      metadata: {
        adminUpdate: true,
        timestamp: Date.now(),
        searchQuery: searchQuery,
      },
      createdAt: new Date().toISOString(),
    };
    
    // Update wallet and add transaction
    const userRef = ref(database, `users/${foundUserId}`);
    await update(userRef, {
      wallet: walletUpdate,
      [`wallet/transactions/${transaction.id}`]: transaction,
    });
    
    console.log(`[Admin] ✅ Wallet updated successfully for user ${foundUserId}`);
    console.log(`[Admin] Previous balance: ${currentBalance} KES`);
    console.log(`[Admin] New balance: ${newBalance} KES`);
    console.log(`[Admin] Change: ${newBalance - currentBalance > 0 ? "+" : ""}${newBalance - currentBalance} KES`);
    
    res.json({
      success: true,
      message: "Wallet balance updated successfully",
      user: {
        userId: foundUserId,
        email: foundUser.email,
        displayName: foundUser.displayName || foundUser.name || foundUser.username || "N/A",
        previousBalance: currentBalance,
        newBalance: newBalance,
        change: newBalance - currentBalance,
      },
      transaction: {
        id: transaction.id,
        type: transaction.type,
        description: transaction.description,
      },
    });
  } catch (error) {
    console.error("[Admin] ❌ Error updating wallet:", error);
    res.status(500).json({ 
      error: "Failed to update wallet",
      message: error.message 
    });
  }
});

module.exports = router;
