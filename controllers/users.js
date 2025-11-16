const { database } = require("../config/firebase");
const { cache, cacheKeys, CACHE_TTL } = require("../utils/cache");
const {
  normalizeUserFromAuth,
  normalizeUserData,
  getNormalizationUpdatePayload,
} = require("../utils/userNormalization");

// Simple in-memory rate limiter for presence sync
const presenceSyncLimiter = new Map();
const PRESENCE_SYNC_RATE_LIMIT = 1000; // 1 second between calls

const getUserProfile = async (req, res) => {
  try {
    const userId = req.user.uid;

    // Check cache first
    const cacheKey = cacheKeys.userProfile(userId);
    const cachedUser = await cache.get(cacheKey);

    if (cachedUser) {
      console.log("📦 Using cached user profile for:", userId);
      return res.status(200).json(cachedUser);
    }

    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      // Normalize user data from Firebase Auth (Google login)
      const normalizedData = normalizeUserFromAuth(req.user);
      
      const newUser = {
        uid: userId,
        email: normalizedData.email,
        displayName: normalizedData.displayName, // Primary searchable field (from Google/Firebase Auth)
        name: normalizedData.name, // Alias for compatibility
        username: normalizedData.username, // Searchable username field
        firstName: normalizedData.firstName, // First name for better search
        lastName: normalizedData.lastName, // Last name for better search
        photoURL: normalizedData.photoURL, // Primary photo field (from Google)
        avatar: normalizedData.avatar, // Alias for compatibility
        bio: "",
        createdAt: new Date().toISOString(),
        friendsCount: 0,
        friends: [],
        clans: [],
        points: 0,
        wallet: {
          amount: 0,
          currency: "KES",
          lastUpdated: new Date().toISOString(),
        },
        // Mark as normalized for search
        _normalizedForSearch: true,
        _normalizedAt: new Date().toISOString(),
      };
      await userRef.set(newUser);
      
      console.log("✅ New user created with normalized data:", {
        userId,
        displayName: newUser.displayName,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        email: newUser.email,
      });

      // Cache the new user
      await cache.set(cacheKey, newUser, CACHE_TTL.USER_PROFILE);

      return res.status(200).json(newUser);
    }

    let userData = userSnapshot.val();

    // Normalize user data for search if not already normalized
    // Also update with latest Firebase Auth data (Google profile may have updated)
    const shouldUpdate = !userData._normalizedForSearch || 
                         (req.user.picture && req.user.picture !== userData.photoURL) ||
                         ((req.user.name || req.user.displayName) && 
                          (req.user.name || req.user.displayName) !== userData.displayName);
    
    if (shouldUpdate) {
      // Merge Firebase Auth data with existing user data
      const normalizedData = normalizeUserFromAuth(req.user, userData);
      
      // Update local userData object
      userData.displayName = normalizedData.displayName;
      userData.name = normalizedData.name;
      userData.username = normalizedData.username;
      userData.firstName = normalizedData.firstName;
      userData.lastName = normalizedData.lastName;
      userData.photoURL = normalizedData.photoURL;
      userData.avatar = normalizedData.avatar;
      userData.email = normalizedData.email || userData.email;
      userData._normalizedForSearch = true;
      userData._normalizedAt = new Date().toISOString();
      
      // Update in database (non-blocking)
      const updatePayload = getNormalizationUpdatePayload(normalizedData);
      userRef.update(updatePayload).catch(err => {
        console.warn(`Failed to normalize user ${userId}:`, err.message);
      });
      
      console.log("✅ User data normalized/updated:", {
        userId,
        displayName: userData.displayName,
        firstName: userData.firstName,
        lastName: userData.lastName,
        wasNormalized: !userData._normalizedForSearch,
      });
    }

    // Ensure wallet object exists with proper structure
    if (!userData.wallet) {
      userData.wallet = {
        amount: 0,
        currency: "KES",
        lastUpdated: new Date().toISOString(),
      };
    }

    // Ensure points field exists
    if (userData.points === undefined) {
      userData.points = 0;
    }

    console.log("User profile data:", {
      userId,
      points: userData.points,
      wallet: userData.wallet,
      hasWallet: !!userData.wallet,
      displayName: userData.displayName,
      normalized: userData._normalizedForSearch,
    });

    // Cache the user data
    await cache.set(cacheKey, userData, CACHE_TTL.USER_PROFILE);

    return res.status(200).json(userData);
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return res.status(500).json({ error: "Failed to fetch user profile" });
  }
};

const updateUserProfile = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { username, avatar, bio, displayName } = req.body;
    if (!username && !avatar && !bio && !displayName) {
      return res.status(400).json({
        error: "At least one field (username, avatar, bio, or displayName) is required",
      });
    }
    
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const existingUserData = userSnapshot.val();
    const updateData = {};
    
    // Handle username update - normalize it
    if (username) {
      updateData.username = username;
      // If displayName is being set from username, extract first/last name
      if (!displayName && !existingUserData.displayName) {
        updateData.displayName = username;
        updateData.name = username;
      }
    }
    
    // Handle displayName update - extract first/last name
    if (displayName) {
      updateData.displayName = displayName;
      updateData.name = displayName;
      
      // Extract first and last name from displayName
      const nameParts = displayName.trim().split(/\s+/);
      if (nameParts.length >= 2) {
        updateData.firstName = nameParts[0];
        updateData.lastName = nameParts.slice(1).join(' ');
      } else if (nameParts.length === 1) {
        updateData.firstName = nameParts[0];
        updateData.lastName = null;
      }
      
      // Update username if not explicitly provided
      if (!username && !existingUserData.username) {
        updateData.username = displayName.toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^\w_]/g, '');
      }
    }
    
    // Handle avatar/photoURL update - keep both fields in sync
    if (avatar) {
      updateData.avatar = avatar;
      updateData.photoURL = avatar;
    }
    
    // Handle bio update
    if (bio !== undefined) {
      updateData.bio = bio;
    }
    
    // Ensure user remains normalized
    updateData._normalizedForSearch = true;
    updateData._normalizedAt = new Date().toISOString();
    
    await userRef.update(updateData);

    // Invalidate cache
    const cacheKey = cacheKeys.userProfile(userId);
    await cache.del(cacheKey);

    console.log("✅ User profile updated with normalized data:", {
      userId,
      updatedFields: Object.keys(updateData),
    });

    return res.status(200).json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("Error updating user profile:", error);
    return res.status(500).json({ error: "Failed to update user profile" });
  }
};

const getUserClans = async (req, res) => {
  try {
    const userId = req.user.uid;
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const clanIds = userSnapshot.val().clans || [];
    const clans = [];
    for (const clanId of clanIds) {
      const clanRef = database.ref(`clans/${clanId}`);
      const clanSnapshot = await clanRef.once("value");
      if (clanSnapshot.exists()) {
        clans.push({ id: clanId, ...clanSnapshot.val() });
      }
    }
    return res.status(200).json(clans);
  } catch (error) {
    console.error("Error fetching user clans:", error);
    return res.status(500).json({ error: "Failed to fetch user clans" });
  }
};

const followUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.uid;
    if (currentUserId === userId) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const userData = userSnapshot.val();
    const currentUserRef = database.ref(`users/${currentUserId}`);
    const currentUserSnapshot = await currentUserRef.once("value");
    const currentUserData = currentUserSnapshot.val();
    if (
      (currentUserData.friends || []).some((friend) => friend.uid === userId)
    ) {
      return res.status(400).json({ error: "Already following this user" });
    }
    const newFriend = {
      uid: userId,
      username: userData.username || userData.email.split("@")[0],
      avatar: userData.avatar || "",
      followedAt: new Date().toISOString(),
    };
    await currentUserRef.update({
      friends: [...(currentUserData.friends || []), newFriend],
      friendsCount: (currentUserData.friendsCount || 0) + 1,
    });
    await userRef.update({
      friendsCount: (userData.friendsCount || 0) + 1,
    });
    return res.status(200).json({ message: "User followed successfully" });
  } catch (error) {
    console.error("Error following user:", error);
    return res.status(500).json({ error: "Failed to follow user" });
  }
};

const unfollowUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.uid;
    if (currentUserId === userId) {
      return res.status(400).json({ error: "Cannot unfollow yourself" });
    }
    const currentUserRef = database.ref(`users/${currentUserId}`);
    const currentUserSnapshot = await currentUserRef.once("value");
    if (!currentUserSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const currentUserData = currentUserSnapshot.val();
    if (
      !(currentUserData.friends || []).some((friend) => friend.uid === userId)
    ) {
      return res.status(400).json({ error: "Not following this user" });
    }
    await currentUserRef.update({
      friends: (currentUserData.friends || []).filter(
        (friend) => friend.uid !== userId
      ),
      friendsCount: (currentUserData.friendsCount || 1) - 1,
    });
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (userSnapshot.exists()) {
      const userData = userSnapshot.val();
      await userRef.update({
        friendsCount: (userData.friendsCount || 1) - 1,
      });
    }
    return res.status(200).json({ message: "User unfollowed successfully" });
  } catch (error) {
    console.error("Error unfollowing user:", error);
    return res.status(500).json({ error: "Failed to unfollow user" });
  }
};

const getFriends = async (req, res) => {
  try {
    const userId = req.params.userId;
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const friends = userSnapshot.val().friends || [];
    return res.status(200).json(friends);
  } catch (error) {
    console.error("Error fetching friends:", error);
    return res.status(500).json({ error: "Failed to fetch friends" });
  }
};

const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const userData = userSnapshot.val();
    return res.status(200).json({
      uid: userId,
      username: userData.username || userData.email.split("@")[0],
      avatar: userData.avatar || "",
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
};

const getUserStatus = async (req, res) => {
  try {
    const userId = req.params.userId;
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const userData = userSnapshot.val();
    const onlineStatus = userData.onlineStatus || {
      isOnline: false,
      lastActive: null,
    };
    return res.status(200).json({
      isOnline: onlineStatus.isOnline,
      lastActive: onlineStatus.lastActive,
    });
  } catch (error) {
    console.error("Error fetching user status:", error);
    return res.status(500).json({ error: "Failed to fetch user status" });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const { isOnline } = req.body;
    const userId = req.user.uid;
    const userRef = database.ref(`users/${userId}`);
    await userRef.update({
      onlineStatus: {
        isOnline: isOnline || false,
        lastActive: new Date().toISOString(),
      },
    });
    return res.status(200).json({ message: "Status updated" });
  } catch (error) {
    console.error("Error updating user status:", error);
    return res.status(500).json({ error: "Failed to update status" });
  }
};

const syncPresence = async (req, res) => {
  try {
    const { userId, isOnline } = req.body;
    const currentUserId = req.user.uid;

    // Validate userId is a string
    if (!userId || typeof userId !== "string") {
      console.error("Invalid userId in syncPresence:", userId, typeof userId);
      return res.status(400).json({ error: "Invalid userId" });
    }

    if (userId !== currentUserId) {
      return res
        .status(403)
        .json({ error: "Unauthorized to sync presence for this user" });
    }

    // Rate limiting for presence sync
    const now = Date.now();
    const lastSync = presenceSyncLimiter.get(userId);
    if (lastSync && now - lastSync < PRESENCE_SYNC_RATE_LIMIT) {
      console.log("⚠️ Presence sync rate limited for user:", userId);
      return res.status(429).json({ error: "Presence sync rate limited" });
    }
    presenceSyncLimiter.set(userId, now);

    // Ensure isOnline is a boolean
    const onlineStatus = Boolean(isOnline);

    console.log(
      "🔄 Syncing presence for user:",
      userId,
      "isOnline:",
      onlineStatus
    );

    // Create simple, flat presence data (no nested objects to avoid stack overflow)
    const presenceData = {
      isOnline: onlineStatus,
      lastActive: Date.now(), // Use timestamp (number) not ISO string
      userId: String(userId),
    };

    // Use Firebase Admin SDK (not modular SDK) with simple .set() and .update()
    try {
      const userIdStr = String(userId);

      // Use Firebase Admin SDK methods
      const presenceRef = database.ref(`presence/${userIdStr}`);
      const userStatusRef = database.ref(`users/${userIdStr}/onlineStatus`);

      // Write simple data only - no complex objects
      await Promise.all([
        presenceRef.set(presenceData),
        userStatusRef.set(presenceData),
      ]);

      console.log("✅ Presence synced successfully for user:", userId);
      return res.status(200).json({ message: "Presence synced" });
    } catch (firebaseError) {
      console.error(
        "❌ Firebase error during presence sync:",
        firebaseError.message
      );
      // Minimal fallback - just update isOnline flag
      try {
        const userIdStr = String(userId);
        await database.ref(`presence/${userIdStr}/isOnline`).set(onlineStatus);
        console.log("✅ Minimal presence sync successful for user:", userId);
        return res.status(200).json({ message: "Presence synced (minimal)" });
      } catch (fallbackError) {
        console.error(
          "❌ Fallback presence sync also failed:",
          fallbackError.message
        );
        // Don't throw - just return success to prevent crashes
        return res.status(200).json({ message: "Presence sync skipped" });
      }
    }
  } catch (error) {
    console.error("Error syncing presence:", error);
    // Return success anyway to prevent frontend errors
    return res.status(200).json({ message: "Presence sync skipped" });
  }
};

const updateUserCountry = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { country } = req.body;

    if (!country) {
      return res.status(400).json({ error: "Country is required" });
    }

    // Validate country code (basic validation)
    if (typeof country !== "string" || country.length !== 2) {
      return res.status(400).json({ error: "Invalid country code format" });
    }

    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");

    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    await userRef.update({
      country: country.toUpperCase(),
      updatedAt: new Date().toISOString(),
    });

    console.log(`Updated user ${userId} country to ${country.toUpperCase()}`);
    return res.status(200).json({
      message: "Country updated successfully",
      country: country.toUpperCase(),
    });
  } catch (error) {
    console.error("Error updating user country:", error);
    return res.status(500).json({ error: "Failed to update user country" });
  }
};

// Friend Request System
const sendFriendRequest = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.uid;

    if (currentUserId === userId) {
      return res
        .status(400)
        .json({ error: "Cannot send friend request to yourself" });
    }

    // Check if target user exists
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userSnapshot.val();
    const currentUserRef = database.ref(`users/${currentUserId}`);
    const currentUserSnapshot = await currentUserRef.once("value");
    const currentUserData = currentUserSnapshot.val();

    // Check if already friends
    const isAlreadyFriend = (currentUserData.friends || []).some(
      (friend) => friend.uid === userId
    );
    if (isAlreadyFriend) {
      return res.status(400).json({ error: "Already friends with this user" });
    }

    // Check if friend request already exists
    const friendRequestsRef = database.ref(`friendRequests/${userId}/received`);
    const existingRequestSnapshot = await friendRequestsRef
      .child(currentUserId)
      .once("value");
    if (existingRequestSnapshot.exists()) {
      return res.status(400).json({ error: "Friend request already sent" });
    }

    // Check if there's a pending request from the target user
    const pendingRequestRef = database.ref(
      `friendRequests/${currentUserId}/received`
    );
    const pendingRequestSnapshot = await pendingRequestRef
      .child(userId)
      .once("value");
    if (pendingRequestSnapshot.exists()) {
      return res
        .status(400)
        .json({ error: "This user has already sent you a friend request" });
    }

    // Create friend request
    const friendRequest = {
      fromUserId: currentUserId,
      fromUsername:
        currentUserData.username ||
        currentUserData.email?.split("@")[0] ||
        "Unknown",
      fromAvatar: currentUserData.avatar || "",
      toUserId: userId,
      toUsername:
        userData.username || userData.email?.split("@")[0] || "Unknown",
      toAvatar: userData.avatar || "",
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    // Save to both users' friend request collections
    await friendRequestsRef.child(currentUserId).set(friendRequest);
    await database
      .ref(`friendRequests/${currentUserId}/sent`)
      .child(userId)
      .set(friendRequest);

    return res.status(200).json({
      message: "Friend request sent successfully",
      requestId: `${currentUserId}_${userId}`,
    });
  } catch (error) {
    console.error("Error sending friend request:", error);
    return res.status(500).json({ error: "Failed to send friend request" });
  }
};

const acceptFriendRequest = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.uid;

    if (currentUserId === userId) {
      return res
        .status(400)
        .json({ error: "Cannot accept friend request from yourself" });
    }

    // Check if friend request exists
    const friendRequestRef = database.ref(
      `friendRequests/${currentUserId}/received/${userId}`
    );
    const requestSnapshot = await friendRequestRef.once("value");

    if (!requestSnapshot.exists()) {
      return res.status(404).json({ error: "Friend request not found" });
    }

    const requestData = requestSnapshot.val();
    if (requestData.status !== "pending") {
      return res
        .status(400)
        .json({ error: "Friend request is no longer pending" });
    }

    // Get both users' data
    const currentUserRef = database.ref(`users/${currentUserId}`);
    const targetUserRef = database.ref(`users/${userId}`);

    const [currentUserSnapshot, targetUserSnapshot] = await Promise.all([
      currentUserRef.once("value"),
      targetUserRef.once("value"),
    ]);

    const currentUserData = currentUserSnapshot.val();
    const targetUserData = targetUserSnapshot.val();

    // Add each other as friends
    const newFriendForCurrentUser = {
      uid: userId,
      username:
        targetUserData.username ||
        targetUserData.email?.split("@")[0] ||
        "Unknown",
      avatar: targetUserData.avatar || "",
      followedAt: new Date().toISOString(),
    };

    const newFriendForTargetUser = {
      uid: currentUserId,
      username:
        currentUserData.username ||
        currentUserData.email?.split("@")[0] ||
        "Unknown",
      avatar: currentUserData.avatar || "",
      followedAt: new Date().toISOString(),
    };

    // Update both users' friends lists
    await Promise.all([
      currentUserRef.update({
        friends: [...(currentUserData.friends || []), newFriendForCurrentUser],
        friendsCount: (currentUserData.friendsCount || 0) + 1,
      }),
      targetUserRef.update({
        friends: [...(targetUserData.friends || []), newFriendForTargetUser],
        friendsCount: (targetUserData.friendsCount || 0) + 1,
      }),
    ]);

    // Remove the friend request
    await Promise.all([
      friendRequestRef.remove(),
      database.ref(`friendRequests/${userId}/sent/${currentUserId}`).remove(),
    ]);

    return res.status(200).json({
      message: "Friend request accepted successfully",
      friend: newFriendForCurrentUser,
    });
  } catch (error) {
    console.error("Error accepting friend request:", error);
    return res.status(500).json({ error: "Failed to accept friend request" });
  }
};

const rejectFriendRequest = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.uid;

    if (currentUserId === userId) {
      return res
        .status(400)
        .json({ error: "Cannot reject friend request from yourself" });
    }

    // Check if friend request exists
    const friendRequestRef = database.ref(
      `friendRequests/${currentUserId}/received/${userId}`
    );
    const requestSnapshot = await friendRequestRef.once("value");

    if (!requestSnapshot.exists()) {
      return res.status(404).json({ error: "Friend request not found" });
    }

    // Remove the friend request
    await Promise.all([
      friendRequestRef.remove(),
      database.ref(`friendRequests/${userId}/sent/${currentUserId}`).remove(),
    ]);

    return res
      .status(200)
      .json({ message: "Friend request rejected successfully" });
  } catch (error) {
    console.error("Error rejecting friend request:", error);
    return res.status(500).json({ error: "Failed to reject friend request" });
  }
};

const getFriendRequests = async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const { type = "received" } = req.query; // "received" or "sent"

    const friendRequestsRef = database.ref(
      `friendRequests/${currentUserId}/${type}`
    );
    const requestsSnapshot = await friendRequestsRef.once("value");

    const requests = requestsSnapshot.val() || {};
    const requestsList = Object.entries(requests).map(([userId, request]) => ({
      id: `${request.fromUserId}_${request.toUserId}`,
      ...request,
    }));

    return res.status(200).json({
      requests: requestsList,
      count: requestsList.length,
    });
  } catch (error) {
    console.error("Error fetching friend requests:", error);
    return res.status(500).json({ error: "Failed to fetch friend requests" });
  }
};

const cancelFriendRequest = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.uid;

    if (currentUserId === userId) {
      return res
        .status(400)
        .json({ error: "Cannot cancel friend request to yourself" });
    }

    // Check if friend request exists
    const friendRequestRef = database.ref(
      `friendRequests/${userId}/received/${currentUserId}`
    );
    const requestSnapshot = await friendRequestRef.once("value");

    if (!requestSnapshot.exists()) {
      return res.status(404).json({ error: "Friend request not found" });
    }

    // Remove the friend request
    await Promise.all([
      friendRequestRef.remove(),
      database.ref(`friendRequests/${currentUserId}/sent/${userId}`).remove(),
    ]);

    return res
      .status(200)
      .json({ message: "Friend request cancelled successfully" });
  } catch (error) {
    console.error("Error cancelling friend request:", error);
    return res.status(500).json({ error: "Failed to cancel friend request" });
  }
};

const getDiscoverUsers = async (req, res) => {
  try {
    const currentUserId = req.user.uid;

    // Get all users from Firebase
    const usersRef = database.ref("users");
    const usersSnapshot = await usersRef.once("value");
    const allUsers = usersSnapshot.val() || {};

    // Convert to array and filter out current user and users without displayName
    const usersArray = Object.entries(allUsers)
      .map(([uid, userData]) => ({
        uid,
        ...userData,
      }))
      .filter(
        (user) =>
          user.uid !== currentUserId &&
          user.displayName &&
          user.displayName.trim() !== ""
      );

    // Shuffle and take 5 random users
    const shuffled = usersArray.sort(() => 0.5 - Math.random());
    const randomUsers = shuffled.slice(0, 5);

    res.status(200).json({
      success: true,
      users: randomUsers,
    });
  } catch (error) {
    console.error("Error fetching discover users:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch discover users",
      error: error.message,
    });
  }
};

module.exports = {
  getUserProfile,
  updateUserProfile,
  getUserClans,
  followUser,
  unfollowUser,
  getFriends,
  getUserById,
  getUserStatus,
  updateUserStatus,
  syncPresence,
  updateUserCountry,
  // Friend Request System
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  getFriendRequests,
  cancelFriendRequest,
  getDiscoverUsers,
};
