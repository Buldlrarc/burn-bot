// Automated Burn Bot - Production Ready for Railway
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createBurnInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fetch from 'node-fetch';
import bs58 from 'bs58';

// Configuration from environment variables
const CONFIG = {
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
  CREATOR_PRIVATE_KEY: process.env.CREATOR_PRIVATE_KEY,
  TOKEN_MINT_ADDRESS: process.env.TOKEN_MINT_ADDRESS,
  MIN_SOL_BALANCE: parseFloat(process.env.MIN_SOL_BALANCE || '0.005'),
  BURN_INTERVAL: 60000, // 60 seconds
};

class BurnBot {
  constructor() {
    this.connection = new Connection(CONFIG.RPC_ENDPOINT, 'confirmed');
    this.wallet = this.loadWallet();
    this.tokenMint = new PublicKey(CONFIG.TOKEN_MINT_ADDRESS);
    this.stats = {
      totalBurns: 0,
      totalTokensBurned: 0,
      totalSolSpent: 0,
      startTime: new Date(),
      lastBurnTime: null,
    };
  }

  loadWallet() {
    try {
      // Decode base58 private key
      const decoded = bs58.decode(CONFIG.CREATOR_PRIVATE_KEY);
      return Keypair.fromSecretKey(decoded);
    } catch (error) {
      console.error('❌ Failed to load wallet. Make sure CREATOR_PRIVATE_KEY is set correctly.');
      console.error('Format: base58 encoded private key');
      process.exit(1);
    }
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const emoji = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
    console.log(`${emoji} [${timestamp}] ${message}`);
  }

  async getBalance() {
    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / 1e9; // Convert to SOL
    } catch (error) {
      this.log(`Failed to get balance: ${error.message}`, 'error');
      return 0;
    }
  }

  async getTokenBalance() {
    try {
      const tokenAccount = await getAssociatedTokenAddress(
        this.tokenMint,
        this.wallet.publicKey
      );
      
      const balance = await this.connection.getTokenAccountBalance(tokenAccount);
      return parseFloat(balance.value.amount);
    } catch (error) {
      // Token account doesn't exist yet
      return 0;
    }
  }

  async buyTokens(solAmount) {
    try {
      this.log(`Attempting to buy with ${solAmount.toFixed(6)} SOL...`);
      
      // Use PumpPortal API for buying
      const response = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: this.wallet.publicKey.toString(),
          action: 'buy',
          mint: CONFIG.TOKEN_MINT_ADDRESS,
          amount: solAmount,
          denominatedInSol: 'true',
          slippage: 10, // 10% slippage
          priorityFee: 0.0005,
          pool: 'pump'
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.arrayBuffer();
      const tx = Transaction.from(Buffer.from(data));
      
      // Sign and send transaction
      tx.sign(this.wallet);
      const signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      
      // Confirm transaction
      await this.connection.confirmTransaction(signature, 'confirmed');
      
      this.log(`✅ Buy successful! TX: ${signature}`, 'success');
      
      // Wait a bit for token account to update
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return { success: true, signature };
    } catch (error) {
      this.log(`Buy failed: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  async burnTokens() {
    try {
      const tokenBalance = await this.getTokenBalance();
      
      if (tokenBalance === 0) {
        this.log('No tokens to burn', 'error');
        return { success: false };
      }

      this.log(`Burning ${tokenBalance} tokens...`);

      const tokenAccount = await getAssociatedTokenAddress(
        this.tokenMint,
        this.wallet.publicKey
      );

      // Create burn instruction
      const burnIx = createBurnInstruction(
        tokenAccount,
        this.tokenMint,
        this.wallet.publicKey,
        BigInt(Math.floor(tokenBalance))
      );

      const transaction = new Transaction().add(burnIx);
      transaction.feePayer = this.wallet.publicKey;
      
      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;

      // Sign and send
      transaction.sign(this.wallet);
      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false }
      );

      await this.connection.confirmTransaction(signature, 'confirmed');
      
      this.log(`✅ Burned ${tokenBalance} tokens! TX: ${signature}`, 'success');
      
      return { success: true, signature, amount: tokenBalance };
    } catch (error) {
      this.log(`Burn failed: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  async executeCycle() {
    try {
      this.log('='.repeat(60));
      this.log('🔥 Starting burn cycle...');
      
      // Check SOL balance
      const solBalance = await this.getBalance();
      this.log(`Current balance: ${solBalance.toFixed(6)} SOL`);
      
      if (solBalance < CONFIG.MIN_SOL_BALANCE) {
        this.log(`Balance too low. Need ${CONFIG.MIN_SOL_BALANCE} SOL minimum.`, 'error');
        return;
      }

      // Reserve for fees
      const buyAmount = Math.max(solBalance - 0.005, 0.001);
      
      if (buyAmount <= 0) {
        this.log('Not enough SOL after fee reservation', 'error');
        return;
      }

      // Execute buy
      const buyResult = await this.buyTokens(buyAmount);
      
      if (!buyResult.success) {
        this.log('Buy failed, skipping burn', 'error');
        return;
      }

      // Wait a moment for tokens to arrive
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Execute burn
      const burnResult = await this.burnTokens();
      
      if (!burnResult.success) {
        this.log('⚠️ CRITICAL: Bought tokens but burn failed!', 'error');
        return;
      }

      // Update stats
      this.stats.totalBurns++;
      this.stats.totalTokensBurned += burnResult.amount;
      this.stats.totalSolSpent += buyAmount;
      this.stats.lastBurnTime = new Date();

      // Log success
      this.log('='.repeat(60));
      this.log(`✅ CYCLE COMPLETE!`, 'success');
      this.log(`💰 SOL Spent: ${buyAmount.toFixed(6)}`);
      this.log(`🔥 Tokens Burned: ${burnResult.amount.toLocaleString()}`);
      this.log(`📊 Total Burns: ${this.stats.totalBurns}`);
      this.log(`📈 Total Burned: ${this.stats.totalTokensBurned.toLocaleString()}`);
      this.log('='.repeat(60));

    } catch (error) {
      this.log(`Critical error: ${error.message}`, 'error');
      console.error(error);
    }
  }

  async start() {
    this.log('🚀 BURN BOT STARTING...');
    this.log(`Wallet: ${this.wallet.publicKey.toString()}`);
    this.log(`Token: ${CONFIG.TOKEN_MINT_ADDRESS}`);
    this.log(`Interval: ${CONFIG.BURN_INTERVAL / 1000}s`);
    this.log(`Min Balance: ${CONFIG.MIN_SOL_BALANCE} SOL`);
    this.log('='.repeat(60));

    // Run first cycle immediately
    await this.executeCycle();

    // Then run every 60 seconds
    setInterval(() => {
      this.executeCycle();
    }, CONFIG.BURN_INTERVAL);
  }
}

// Validate config before starting
function validateConfig() {
  const required = ['CREATOR_PRIVATE_KEY', 'TOKEN_MINT_ADDRESS'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\nSet these in Railway dashboard under Variables');
    process.exit(1);
  }
}

// Main execution
async function main() {
  console.log(`
╔════════════════════════════════════════╗
║         BURN PROTOCOL BOT             ║
║    Automated Buyback & Burn v1.0      ║
╚════════════════════════════════════════╝
  `);

  validateConfig();
  
  const bot = new BurnBot();
  
  // Handle shutdown gracefully
  process.on('SIGTERM', () => {
    console.log('\n📊 Final Statistics:');
    console.log(JSON.stringify(bot.stats, null, 2));
    process.exit(0);
  });

  await bot.start();
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});