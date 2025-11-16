const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const {
  migrateChallengeIndexes,
  checkMigrationStatus,
} = require("../utils/migrateChallengeIndex");
const { normalizeAllUsers } = require("../scripts/normalizeUsersForSearch");

/**
 * Migration Routes
 * Handles data migration for existing challenges
 */

// Check migration status
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const status = await checkMigrationStatus();
    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error("Error checking migration status:", error);
    res.status(500).json({
      error: "Failed to check migration status",
      message: error.message,
    });
  }
});

// Run challenge index migration
router.post("/challenge-index", authenticateToken, async (req, res) => {
  try {
    console.log("🚀 Starting challenge index migration...");
    const result = await migrateChallengeIndexes();

    res.json({
      success: true,
      message: "Challenge index migration completed",
      ...result,
    });
  } catch (error) {
    console.error("Error running migration:", error);
    res.status(500).json({
      error: "Migration failed",
      message: error.message,
    });
  }
});

// Normalize all users for search
router.post("/normalize-users", authenticateToken, async (req, res) => {
  try {
    console.log("🚀 Starting user normalization for search...");
    const result = await normalizeAllUsers();

    res.json({
      success: true,
      message: "User normalization completed",
      ...result,
    });
  } catch (error) {
    console.error("Error normalizing users:", error);
    res.status(500).json({
      error: "Normalization failed",
      message: error.message,
    });
  }
});

module.exports = router;
