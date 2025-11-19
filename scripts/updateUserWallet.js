/**
 * Script to find a user by email and update their wallet balance
 * Usage: node scripts/updateUserWallet.js <email> <balance>
 * Example: node scripts/updateUserWallet.js kimathibrian71@gmail.com 3000
 */

// Use the existing Firebase config that's already set up
const { database } = require('../config/firebase');
const db = database;

// Get command line arguments
const email = process.argv[2] || 'kimathibrian71@gmail.com';
const newBalance = parseFloat(process.argv[3]) || 3000;

if (!email) {
  console.error('❌ Error: Email is required');
  console.log('Usage: node scripts/updateUserWallet.js <email> <balance>');
  process.exit(1);
}

async function findUserByEmail(searchEmail) {
  try {
    console.log(`\n🔍 Searching for user with email: ${searchEmail}`);
    
    // Get all users using Admin SDK
    const usersRef = db.ref('users');
    const usersSnapshot = await usersRef.once('value');
    
    if (!usersSnapshot.exists()) {
      console.error('❌ No users found in database');
      return null;
    }
    
    const users = usersSnapshot.val();
    let foundUser = null;
    let foundUserId = null;
    
    // Search through all users
    for (const [userId, userData] of Object.entries(users)) {
      if (userData && userData.email && userData.email.toLowerCase() === searchEmail.toLowerCase()) {
        foundUser = userData;
        foundUserId = userId;
        break;
      }
    }
    
    if (!foundUser) {
      console.error(`❌ User with email "${searchEmail}" not found`);
      return null;
    }
    
    console.log(`✅ User found!`);
    console.log(`   User ID: ${foundUserId}`);
    console.log(`   Email: ${foundUser.email}`);
    console.log(`   Display Name: ${foundUser.displayName || foundUser.name || 'N/A'}`);
    console.log(`   Current Wallet Balance: ${foundUser.wallet?.amount || 0} KES`);
    console.log(`   Current Escrow Balance: ${foundUser.wallet?.escrowBalance || 0} KES`);
    
    return { userId: foundUserId, userData: foundUser };
  } catch (error) {
    console.error('❌ Error finding user:', error);
    return null;
  }
}

async function updateWalletBalance(userId, balance) {
  try {
    console.log(`\n💰 Updating wallet balance for user: ${userId}`);
    console.log(`   New balance: ${balance} KES`);
    
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    
    if (!userSnapshot.exists()) {
      console.error(`❌ User ${userId} not found`);
      return false;
    }
    
    const userData = userSnapshot.val();
    const currentBalance = userData.wallet?.amount || 0;
    const currentEscrow = userData.wallet?.escrowBalance || 0;
    
    // Prepare wallet update
    const walletUpdate = {
      amount: balance,
      escrowBalance: currentEscrow, // Preserve escrow balance
      updatedAt: new Date().toISOString(),
      currency: userData.wallet?.currency || 'KES',
    };
    
    // Preserve createdAt if it exists
    if (userData.wallet?.createdAt) {
      walletUpdate.createdAt = userData.wallet.createdAt;
    } else {
      walletUpdate.createdAt = new Date().toISOString();
    }
    
    // Create a transaction record for audit
    const transaction = {
      id: `admin_update_${Date.now()}`,
      amount: balance - currentBalance, // Difference
      type: balance > currentBalance ? 'credit' : 'debit',
      description: `Admin wallet balance update: ${currentBalance} → ${balance} KES`,
      balanceBefore: currentBalance,
      balanceAfter: balance,
      metadata: {
        adminUpdate: true,
        timestamp: Date.now(),
      },
      createdAt: new Date().toISOString(),
    };
    
    // Update wallet and add transaction using Admin SDK
    await userRef.update({
      'wallet': walletUpdate,
      [`wallet/transactions/${transaction.id}`]: transaction,
    });
    
    console.log(`✅ Wallet balance updated successfully!`);
    console.log(`   Previous balance: ${currentBalance} KES`);
    console.log(`   New balance: ${balance} KES`);
    console.log(`   Change: ${balance - currentBalance > 0 ? '+' : ''}${balance - currentBalance} KES`);
    console.log(`   Transaction ID: ${transaction.id}`);
    
    return true;
  } catch (error) {
    console.error('❌ Error updating wallet balance:', error);
    return false;
  }
}

async function main() {
  try {
    console.log('🚀 Starting wallet update script...');
    console.log(`📧 Email: ${email}`);
    console.log(`💰 New Balance: ${newBalance} KES`);
    
    // Find user by email
    const user = await findUserByEmail(email);
    
    if (!user) {
      console.error('\n❌ Cannot proceed: User not found');
      process.exit(1);
    }
    
    // Update wallet balance
    const success = await updateWalletBalance(user.userId, newBalance);
    
    if (success) {
      console.log('\n✅ Script completed successfully!');
      process.exit(0);
    } else {
      console.error('\n❌ Script failed: Could not update wallet');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run the script
main();

