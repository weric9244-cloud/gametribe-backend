# Update User Wallet Script

This script finds a user by email and updates their wallet balance.

## Usage

```bash
node scripts/updateUserWallet.js <email> <balance>
```

## Examples

### Update wallet to 3000 KES for kimathibrian71@gmail.com
```bash
node scripts/updateUserWallet.js kimathibrian71@gmail.com 3000
```

### Update wallet to 5000 KES for any email
```bash
node scripts/updateUserWallet.js user@example.com 5000
```

## Default Values

If no arguments are provided, the script uses:
- Email: `kimathibrian71@gmail.com`
- Balance: `3000`

## What the Script Does

1. **Searches for user** by email in Firebase Realtime Database
2. **Displays user information**:
   - User ID
   - Email
   - Display Name
   - Current wallet balance
   - Current escrow balance
3. **Updates wallet balance** to the specified amount
4. **Creates a transaction record** for audit purposes
5. **Preserves escrow balance** (only updates main balance)

## Output

The script will show:
- ✅ User found confirmation with details
- ✅ Wallet update confirmation
- ✅ Previous balance → New balance
- ✅ Transaction ID for audit

## Error Handling

- ❌ User not found if email doesn't exist
- ❌ Error messages if database connection fails
- ❌ Validation errors for invalid inputs

## Security Note

This script directly modifies wallet balances. Use with caution and ensure proper authorization.




