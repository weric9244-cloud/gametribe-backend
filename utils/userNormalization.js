/**
 * User Data Normalization Utility
 * 
 * Centralized utility for normalizing user data to ensure efficient searchability.
 * Used during user creation, profile updates, and authentication.
 * 
 * This ensures all users have:
 * - displayName (primary searchable field, from Google/Firebase Auth)
 * - name (alias for compatibility)
 * - username (searchable username field)
 * - firstName and lastName (extracted from displayName)
 * - photoURL and avatar (consistent photo fields)
 * - email (from Firebase Auth)
 */

/**
 * Normalize user data from Firebase Auth (Google login) and existing data
 * @param {Object} authUser - Firebase Auth user data (from req.user)
 * @param {Object} existingUserData - Existing user data from database (optional)
 * @returns {Object} Normalized user data
 */
function normalizeUserFromAuth(authUser, existingUserData = {}) {
  // Extract name from Firebase Auth (prioritizes displayName from Google)
  const authDisplayName = authUser.name || authUser.displayName || null;
  const emailName = authUser.email && typeof authUser.email === "string"
    ? authUser.email.split("@")[0]
    : null;
  
  // Prioritize Firebase Auth name (Google profile) over existing data or email
  const displayName = authDisplayName || 
                      existingUserData.displayName || 
                      existingUserData.name || 
                      existingUserData.fullName ||
                      existingUserData.username ||
                      emailName || 
                      "User";
  
  // Extract first and last name from displayName if available
  let firstName = existingUserData.firstName || null;
  let lastName = existingUserData.lastName || null;
  
  if (displayName && displayName !== emailName && (!firstName || !lastName)) {
    const nameParts = displayName.trim().split(/\s+/);
    if (nameParts.length >= 2) {
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ');
    } else if (nameParts.length === 1) {
      firstName = nameParts[0];
    }
  }
  
  // Create username from displayName if not provided
  const username = existingUserData.username || 
                   displayName.toLowerCase()
                     .replace(/\s+/g, '_')
                     .replace(/[^\w_]/g, '');
  
  // Prioritize Firebase Auth photo (Google profile) over existing data
  const photoURL = authUser.picture || 
                   authUser.photoURL || 
                   existingUserData.photoURL || 
                   existingUserData.avatar || 
                   "";
  
  const avatar = photoURL; // Keep both fields for compatibility
  
  return {
    displayName, // Primary searchable field (from Google/Firebase Auth)
    name: displayName, // Alias for compatibility
    username, // Searchable username field
    firstName, // First name for better search
    lastName, // Last name for better search
    photoURL, // Primary photo field (from Google)
    avatar, // Alias for compatibility
    email: authUser.email || existingUserData.email || "",
  };
}

/**
 * Normalize existing user data (without Firebase Auth data)
 * @param {Object} userData - Existing user data from database
 * @param {string} userId - User ID
 * @returns {Object} Normalized user data
 */
function normalizeUserData(userId, userData) {
  const normalized = {
    ...userData,
    uid: userId,
  };

  // Extract displayName from various sources
  if (!normalized.displayName) {
    normalized.displayName = normalized.name || 
                             normalized.fullName || 
                             normalized.username ||
                             (normalized.email ? normalized.email.split('@')[0] : 'User');
  }
  
  // Ensure name field exists
  if (!normalized.name && normalized.displayName) {
    normalized.name = normalized.displayName;
  }
  
  // Extract first and last name from displayName if available
  if (normalized.displayName && !normalized.firstName && !normalized.lastName) {
    const nameParts = normalized.displayName.trim().split(/\s+/);
    if (nameParts.length >= 2) {
      normalized.firstName = nameParts[0];
      normalized.lastName = nameParts.slice(1).join(' ');
    } else if (nameParts.length === 1) {
      normalized.firstName = nameParts[0];
    }
  }
  
  // Ensure username exists (create from displayName if missing)
  if (!normalized.username && normalized.displayName) {
    normalized.username = normalized.displayName
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w_]/g, '');
  }
  
  // Ensure photoURL exists (from avatar if available)
  if (!normalized.photoURL && normalized.avatar) {
    normalized.photoURL = normalized.avatar;
  }
  if (!normalized.avatar && normalized.photoURL) {
    normalized.avatar = normalized.photoURL;
  }
  
  return normalized;
}

/**
 * Get update payload for normalizing user data in database
 * @param {Object} normalizedData - Normalized user data
 * @returns {Object} Update payload for Firebase
 */
function getNormalizationUpdatePayload(normalizedData) {
  const updatePayload = {};
  
  if (normalizedData.displayName) updatePayload.displayName = normalizedData.displayName;
  if (normalizedData.name) updatePayload.name = normalizedData.name;
  if (normalizedData.username) updatePayload.username = normalizedData.username;
  if (normalizedData.firstName) updatePayload.firstName = normalizedData.firstName;
  if (normalizedData.lastName) updatePayload.lastName = normalizedData.lastName;
  if (normalizedData.photoURL) updatePayload.photoURL = normalizedData.photoURL;
  if (normalizedData.avatar) updatePayload.avatar = normalizedData.avatar;
  if (normalizedData.email) updatePayload.email = normalizedData.email;
  
  // Mark as normalized
  updatePayload._normalizedForSearch = true;
  updatePayload._normalizedAt = new Date().toISOString();
  
  return updatePayload;
}

module.exports = {
  normalizeUserFromAuth,
  normalizeUserData,
  getNormalizationUpdatePayload,
};

