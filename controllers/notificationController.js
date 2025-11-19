const { database } = require("../config/firebase");
const {
  ref,
  get,
  set,
  push,
  update,
  remove,
  onValue,
  off,
} = require("firebase/database");

/**
 * Notification Controller
 * Handles real-time notifications for challenge system
 */

/**
 * Get user notifications
 */
const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { limit = 20, offset = 0, unreadOnly = false } = req.query;

    const notificationsRef = ref(database, `notifications/${userId}`);
    const notificationsSnap = await get(notificationsRef);

    if (!notificationsSnap.exists()) {
      return res.json({
        success: true,
        notifications: [],
        unreadCount: 0,
      });
    }

    const notificationsData = notificationsSnap.val();
    let notifications = Object.entries(notificationsData).map(
      ([id, notification]) => ({
        id,
        ...notification,
      })
    );

    // Filter unread only if requested
    if (unreadOnly === "true") {
      notifications = notifications.filter(
        (notification) => !notification.read
      );
    }

    // Sort by timestamp (newest first)
    notifications.sort((a, b) => b.timestamp - a.timestamp);

    // Paginate
    const paginatedNotifications = notifications.slice(
      offset,
      offset + parseInt(limit)
    );

    // Count unread notifications
    const unreadCount = notifications.filter(
      (notification) => !notification.read
    ).length;

    res.json({
      success: true,
      notifications: paginatedNotifications,
      unreadCount,
      total: notifications.length,
      hasMore: notifications.length > offset + parseInt(limit),
    });
  } catch (error) {
    console.error("Error getting user notifications:", error);
    res.status(500).json({
      error: "Failed to get notifications",
      message: error.message,
    });
  }
};

/**
 * Mark notification as read
 */
const markNotificationAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.user.uid;

    const notificationRef = ref(
      database,
      `notifications/${userId}/${notificationId}`
    );
    const notificationSnap = await get(notificationRef);

    if (!notificationSnap.exists()) {
      return res.status(404).json({ error: "Notification not found" });
    }

    await update(notificationRef, {
      read: true,
      readAt: Date.now(),
    });

    res.json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({
      error: "Failed to mark notification as read",
      message: error.message,
    });
  }
};

/**
 * Mark all notifications as read
 */
const markAllNotificationsAsRead = async (req, res) => {
  try {
    const userId = req.user.uid;

    const notificationsRef = ref(database, `notifications/${userId}`);
    const notificationsSnap = await get(notificationsRef);

    if (!notificationsSnap.exists()) {
      return res.json({
        success: true,
        message: "No notifications to mark as read",
      });
    }

    const notificationsData = notificationsSnap.val();
    const updates = {};

    Object.keys(notificationsData).forEach((notificationId) => {
      if (!notificationsData[notificationId].read) {
        updates[`${notificationId}/read`] = true;
        updates[`${notificationId}/readAt`] = Date.now();
      }
    });

    if (Object.keys(updates).length > 0) {
      await update(notificationsRef, updates);
    }

    res.json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({
      error: "Failed to mark all notifications as read",
      message: error.message,
    });
  }
};

/**
 * Delete notification
 */
const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.user.uid;

    const notificationRef = ref(
      database,
      `notifications/${userId}/${notificationId}`
    );
    const notificationSnap = await get(notificationRef);

    if (!notificationSnap.exists()) {
      return res.status(404).json({ error: "Notification not found" });
    }

    await remove(notificationRef);

    res.json({
      success: true,
      message: "Notification deleted",
    });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({
      error: "Failed to delete notification",
      message: error.message,
    });
  }
};

/**
 * Clear all notifications
 */
const clearAllNotifications = async (req, res) => {
  try {
    const userId = req.user.uid;

    const notificationsRef = ref(database, `notifications/${userId}`);
    await remove(notificationsRef);

    res.json({
      success: true,
      message: "All notifications cleared",
    });
  } catch (error) {
    console.error("Error clearing all notifications:", error);
    res.status(500).json({
      error: "Failed to clear notifications",
      message: error.message,
    });
  }
};

/**
 * Get notification count for navbar
 */
const getNotificationCount = async (req, res) => {
  try {
    const userId = req.user.uid;

    const notificationsRef = ref(database, `notifications/${userId}`);
    const notificationsSnap = await get(notificationsRef);

    if (!notificationsSnap.exists()) {
      return res.json({
        success: true,
        unreadCount: 0,
      });
    }

    const notificationsData = notificationsSnap.val();
    const unreadCount = Object.values(notificationsData).filter(
      (notification) => !notification.read
    ).length;

    res.json({
      success: true,
      unreadCount,
    });
  } catch (error) {
    console.error("Error getting notification count:", error);
    res.status(500).json({
      error: "Failed to get notification count",
      message: error.message,
    });
  }
};

/**
 * Create notification (internal use)
 */
const createNotification = async (userId, notificationData) => {
  try {
    const notificationRef = ref(
      database,
      `notifications/${userId}/${notificationData.id}`
    );
    console.log(`[NotificationController] Creating notification for user ${userId}:`, {
      id: notificationData.id,
      type: notificationData.type,
      title: notificationData.title,
      message: notificationData.message,
      createdAt: notificationData.createdAt,
    });
    await set(notificationRef, notificationData);
    console.log(`[NotificationController] ✅ Notification created successfully at notifications/${userId}/${notificationData.id}`);
    return true;
  } catch (error) {
    console.error("[NotificationController] ❌ Error creating notification:", error);
    return false;
  }
};

/**
 * Create challenge notification (PlayChat format)
 */
const createChallengeNotification = async (
  challengerId,
  challengedId,
  challengeData
) => {
  try {
    const challengerName = challengeData.challengerName || "Someone";
    const betAmount = challengeData.betAmount || 0;
    const gameTitle = challengeData.gameTitle || "a game";
    
    const notificationData = {
      id: `challenge_${Date.now()}_${challengerId}`,
      userId: challengerId, // Who triggered the notification
      userName: challengerName,
      userAvatar: challengeData.challengerAvatar || "",
      recipientId: challengedId, // Who receives it
      type: "challenge", // PlayChat expects "challenge" type
      title: "🎯 New Challenge!",
      message: `${challengerName} challenged you to ${gameTitle} for ${betAmount} KES`,
      challengeId: challengeData.challengeId,
      createdAt: Date.now(),
      isRead: false,
    };

    return await createNotification(challengedId, notificationData);
  } catch (error) {
    console.error("Error creating challenge notification:", error);
    return false;
  }
};

/**
 * Create challenge result notification (PlayChat format)
 */
const createChallengeResultNotification = async (userId, resultData) => {
  try {
    const result = resultData.result; // 'won', 'lost', 'tie'
    const gameTitle = resultData.gameTitle || "the game";
    const opponentName = resultData.opponentName || "Your opponent";
    const betAmount = resultData.betAmount || 0;
    const prizeAmount = resultData.prizeAmount || 0;

    let title, message;
    if (result === "won") {
      title = "🏆 You Won!";
      message = `Congratulations! You won the challenge against ${opponentName} in ${gameTitle}. You earned ${prizeAmount} KES!`;
    } else if (result === "lost") {
      title = "💪 Challenge Completed";
      message = `${opponentName} won the challenge in ${gameTitle}. Better luck next time!`;
    } else {
      title = "🤝 Challenge Tied!";
      message = `You tied with ${opponentName} in ${gameTitle}. Well played!`;
    }

    const notificationData = {
      id: `result_${Date.now()}_${resultData.challengeId}`,
      userId: userId, // The user receiving the notification
      userName: opponentName,
      userAvatar: resultData.opponentAvatar || "",
      recipientId: userId,
      type: "challenge", // PlayChat expects "challenge" type
      title: title,
      message: message,
      challengeId: resultData.challengeId,
      createdAt: Date.now(),
      isRead: false,
    };

    return await createNotification(userId, notificationData);
  } catch (error) {
    console.error("Error creating challenge result notification:", error);
    return false;
  }
};

/**
 * Create score submission notification (PlayChat format)
 */
const createScoreSubmissionNotification = async (
  submitterId,
  opponentId,
  challengeData
) => {
  try {
    // Get submitter's name
    const submitterRef = ref(database, `users/${submitterId}`);
    const submitterSnap = await get(submitterRef);
    let submitterName = "Your opponent";
    let submitterAvatar = "";
    
    if (submitterSnap.exists()) {
      const submitterData = submitterSnap.val();
      submitterName = submitterData.displayName || submitterData.username || submitterData.name || "Your opponent";
      submitterAvatar = submitterData.photoURL || submitterData.avatar || "";
    }

    const gameTitle = challengeData.gameTitle || "the game";
    const score = challengeData.challengerId === submitterId 
      ? challengeData.challengerScore 
      : challengeData.challengedScore;

    const notificationData = {
      id: `score_${Date.now()}_${submitterId}_${challengeData.challengeId}`,
      userId: submitterId,
      userName: submitterName,
      userAvatar: submitterAvatar,
      recipientId: opponentId,
      type: "challenge", // PlayChat expects "challenge" type
      title: "📊 Score Submitted",
      message: `${submitterName} submitted their score for ${gameTitle}`,
      challengeId: challengeData.challengeId || challengeData.id,
      createdAt: Date.now(),
      isRead: false,
    };

    return await createNotification(opponentId, notificationData);
  } catch (error) {
    console.error("Error creating score submission notification:", error);
    return false;
  }
};

/**
 * Create system notification
 */
const createSystemNotification = async (userId, systemData) => {
  try {
    const notificationData = {
      id: `system_${Date.now()}_${userId}`,
      userId: userId,
      userName: "System",
      userAvatar: "",
      recipientId: userId,
      type: "system",
      title: systemData.title,
      message: systemData.message,
      createdAt: Date.now(),
      isRead: false,
    };

    return await createNotification(userId, notificationData);
  } catch (error) {
    console.error("Error creating system notification:", error);
    return false;
  }
};

module.exports = {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  clearAllNotifications,
  getNotificationCount,
  createNotification,
  createChallengeNotification,
  createChallengeResultNotification,
  createScoreSubmissionNotification,
  createSystemNotification,
};

