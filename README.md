# Smart Contract Error Monitor

A Next.js application for monitoring **failed transactions** for **any EVM contract** you configure, across **multiple chains**. Use it as a general-purpose scanner: add chain RPCs and contract addresses (with optional deployment blocks), fetch failures from the block explorer API, and replay / decode revert data via your RPC.

Default presets still include **Sepolia** and **Gnosis** example contracts for convenience; the app is not limited to a single protocol.

## 🚀 Features

- **Multi-Chain Support**: Monitor failed transactions on Sepolia and Gnosis chains
- **Multiple Contracts**: Track various smart contracts per chain
- **Failed Transaction Focus**: Only fetches and stores error transactions for efficiency
- **Smart Pagination**: Fetches newest transactions first (100 pages initially), with "Fetch More" for historical data
- **Deployment Block Optimization**: Starts fetching from actual contract deployment blocks (not genesis)
- **API Window Limits**: Handles Gnosis API limits (PageNo × Offset ≤ 10000) automatically
- **Detailed Error Analysis**: Uses RPC calls to get detailed error reasons with custom error mapping
- **Persistent Storage**: LocalStorage-based data persistence with compression and page tracking
- **Configurable Limits**: All constants centralized in `src/constants.ts` for easy adjustment

## 📊 Supported Chains & Contracts

### Sepolia Testnet
- **Redistribution**: `0xb45242E53EA394B2344211BdF9F63CA32E8Abf38` (Block: 8262535)
- **PostageStamp**: `0xcdfdC3752caaA826fE62531E0000C40546eC56A6` (Block: 6596277) 
- **PriceOracle**: `0x95Dc18380e92C13E4F8a4e94C99FB1b97250174B` (Block: 8226873)
- **Staking**: `0xEEF13Ef9eD9cDD169701eeF3cd832df298dD1bB4` (Block: 8262529)

### Gnosis Chain
- **Redis**: `0x69C62CaCd68C2CBBf3D0C7502eF556DB3AC7889B` (Block: 37339181)
- **Oracle**: `0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b` (Block: 37339168)
- **Stamp**: `0x45a1502382541Cd610CC9068e88727426b696293` (Block: 31305656)
- **Stake**: `0x445B848e16730988F871c4a09aB74526d27c2Ce8` (Block: 37339175)

## 🔧 How It Works

### Data Fetching Process

1. **Smart Fetching**: Fetches transactions in descending order (newest first) starting from deployment blocks
2. **Page Limits**: Initial fetch covers 100 pages, with "Fetch More" for additional 100 pages of historical data
3. **API Window Handling**: Automatically adjusts page size to respect API limits (e.g., Gnosis PageNo × Offset ≤ 10000)
4. **Filtering**: Only processes transactions where `isError === "1"` or `txreceipt_status === "0"`
5. **Error Analysis**: Makes RPC calls to get detailed error reasons for failed transactions (first 50 only)
6. **Custom Error Mapping**: Decodes contract-specific error signatures to human-readable names
7. **Storage**: Compresses and stores data in browser localStorage with chain/contract separation and page tracking

### API Endpoints Used

Uses **Etherscan API V2** - a unified endpoint for all chains:

- **Base URL**: `https://api.etherscan.io/v2/api`
- **Chain ID parameter**: `chainid=11155111` (Sepolia), `chainid=100` (Gnosis)
- **Single API key** works for all 60+ supported chains

📖 [Etherscan API V2 Documentation](https://docs.etherscan.io/introduction) | [Supported Chains](https://docs.etherscan.io/supported-chains)

### API Response Structure

#### Successful API Response
```json
{
  "status": "1",
  "message": "OK", 
  "result": [
    {
      "blockNumber": "8262535",
      "timeStamp": "1677123456",
      "hash": "0xabc123...",
      "from": "0x123...",
      "to": "0x456...",
      "value": "1000000000000000000",
      "gas": "21000",
      "gasPrice": "20000000000",
      "gasUsed": "21000", 
      "isError": "1",
      "txreceipt_status": "0",
      "input": "0xa9059cbb...",
      "methodId": "0xa9059cbb",
      "functionName": "transfer(address,uint256)"
    }
  ]
}
```

#### Failed Transaction Example (Our Target)
```json
{
  "blockNumber": "8262535",
  "timeStamp": "1677123456", 
  "hash": "0xabcdef123456789...",
  "from": "0x1234567890abcdef...",
  "to": "0xb45242E53EA394B2344211BdF9F63CA32E8Abf38",
  "value": "0",
  "gas": "100000",
  "gasPrice": "20000000000",
  "gasUsed": "23456",
  "isError": "1",           // ← This indicates a failed transaction
  "txreceipt_status": "0",  // ← Alternative failure indicator
  "input": "0xa9059cbb000000000000000000000000...",
  "methodId": "0xa9059cbb",
  "functionName": "transfer(address,uint256)",
  "errorReason": "Insufficient balance",  // ← Added by our RPC analysis
  "errorName": "REVERT_REASON"            // ← Added by our RPC analysis
}
```

#### API Error Responses

##### Rate Limit Exceeded
```json
{
  "status": "0",
  "message": "NOTOK", 
  "result": "Max rate limit reached, please use API Key for higher rate limit"
}
```

##### Invalid API Key
```json
{
  "status": "0",
  "message": "NOTOK",
  "result": "Invalid API Key"
}
```

##### No Transactions Found
```json
{
  "status": "0", 
  "message": "NOTOK",
  "result": "No transactions found"
}
```

##### Query Timeout
```json
{
  "status": "0",
  "message": "NOTOK", 
  "result": "Query Timeout occured. Please select a smaller result dataset"
}
```

### Error Analysis Process

After fetching failed transactions from the API, the application performs additional RPC calls to get detailed error reasons:

```javascript
// Example RPC call for error analysis
const provider = new ethers.JsonRpcProvider(rpcUrl);
try {
  await provider.call({
    to: tx.to,
    data: tx.input,
    from: tx.from,
    value: tx.value
  });
} catch (callError) {
  // Extract detailed error information
  if (callError.reason) {
    tx.errorReason = callError.reason;
    tx.errorName = callError.code || 'CALL_EXCEPTION';
  }
  // ... additional error parsing
}
```

### Common Error Types

| Error Name | Description | Example Reason |
|------------|-------------|----------------|
| `REVERT_REASON` | Smart contract reverted with reason | "Insufficient balance" |
| `INSUFFICIENT_FUNDS` | Not enough ETH for transaction | "Insufficient funds for transaction" |
| `GAS_ERROR` | Gas-related issues | "Gas estimation failed" |
| `CALL_EXCEPTION` | General call failure | "execution reverted" |
| `UNKNOWN_ERROR` | Unclassified error | Truncated error message |

## 💾 Data Storage

### LocalStorage Structure

Data is stored separately for each chain/contract combination:

```
localStorage keys:
- sepolia_redistribution_transactions
- sepolia_redistribution_block  
- sepolia_redistribution_pages
- sepolia_postagestamp_transactions
- sepolia_postagestamp_block
- sepolia_postagestamp_pages
- gnosis_redis_transactions
- gnosis_redis_block
- gnosis_redis_pages
... (and so on for each chain/contract)
```

### Storage Optimization

- **Compression**: Input data truncated to 100 characters
- **Size Limits**: Maximum 2000 failed transactions per contract
- **Page Tracking**: Stores number of pages fetched for continuation
- **Cleanup**: Keeps most recent 1000 transactions if storage exceeds 4MB
- **Monitoring**: Real-time storage size tracking

## 🏃‍♂️ Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd sc-stats

# Install dependencies  
npm install

# Start development server
npm run dev
```

Visit `http://localhost:3000` (or the port shown in terminal)

### Configuration

The application uses **Etherscan API V2** with a single API key for all chains. Configure your API key through the in-app settings modal.

Get your API key from [etherscan.io/myapikey](https://etherscan.io/myapikey) - one key works for Sepolia, Gnosis, and all other [supported chains](https://docs.etherscan.io/supported-chains).

## 🎯 Usage

1. **Select Chain**: Choose between Sepolia or Gnosis
2. **Select Contract**: Pick the contract you want to monitor
3. **Fetch Failed Transactions**: Click to get the most recent 100 pages of failed transactions
4. **Fetch More (Past)**: Get additional 100 pages of historical failed transactions
5. **View Details**: Browse failed transactions with decoded error names and explorer links
6. **Error Filtering**: Filter transactions by specific error types

### Rate Limiting

- **Etherscan API V2**: 5 calls/second (free tier)
- Built-in 600ms delays between API calls to stay within limits
- Graceful error handling for rate limit exceeded

## ⚙️ Configuration

### Constants Structure (`src/constants.ts`)

All application settings are centralized in the constants file:

```typescript
// Etherscan API V2 - unified endpoint for all chains
export const ETHERSCAN_API_V2_URL = 'https://api.etherscan.io/v2/api';

export const CHAINS = {
  sepolia: {
    name: 'Sepolia Testnet',
    chainId: 11155111, // Etherscan API V2 chain ID
    explorerUrl: 'https://sepolia.etherscan.io',
    contracts: {
      redistribution: {
        name: 'Redistribution',
        address: '0x5b718E36F5Ce2F2F7e25A397040436Ce6af3e89e',
        deploymentBlock: 8262535
      }
      // ... more contracts
    }
  },
  gnosis: {
    name: 'Gnosis Chain',
    chainId: 100, // Etherscan API V2 chain ID
    explorerUrl: 'https://gnosisscan.io',
    contracts: { /* ... */ }
  }
};

export const APP_CONFIG = {
  MAX_FAILED_TRANSACTIONS: 2000,
  TRANSACTIONS_PER_PAGE: 50,
  API_PAGE_SIZE: 10000,
  API_MAX_WINDOW: 10000,
  INITIAL_PAGES_TO_FETCH: 100,
  ADDITIONAL_PAGES_TO_FETCH: 100,
  MAX_TRANSACTIONS_TO_ANALYZE: 50,
  API_DELAY_MS: 600, // Stay within rate limits
  // ... more settings
};
```

### Error Mappings (`src/errorMappings.ts`)

Custom error signatures are mapped to human-readable names:

```typescript
export const CONTRACT_ERROR_MAPPINGS = {
  '0xb45242E53EA394B2344211BdF9F63CA32E8Abf38': { // Redistribution
    '0x8ecf3d03': 'BelowMinimumStake()',
    '0x123abc45': 'InsufficientBalance()',
    // ... more error mappings
  }
  // ... more contracts
};
```

## 🛠️ Technical Details

### Built With

- **Next.js 14** - React framework with App Router
- **TypeScript** - Type safety and better development experience
- **Tailwind CSS** - Utility-first styling
- **ethers.js** - Ethereum interactions and RPC calls
- **Browser APIs** - LocalStorage for persistence

### Key Components

- **`src/constants.ts`** - Centralized configuration for chains, contracts, deployment blocks, and app settings
- **`src/errorMappings.ts`** - Custom error signature mappings for human-readable error names
- **Smart Pagination** - Newest-first fetching with configurable page limits
- **Client-side Rendering** - Prevents hydration errors with localStorage
- **Comprehensive Error Handling** - Graceful handling of API limits, network issues, and storage errors

### API Rate Limiting Strategy

```javascript
// Built-in delays between requests
await new Promise(resolve => setTimeout(resolve, APP_CONFIG.API_DELAY_MS));

// Dynamic page size for API window limits (Gnosis)
let pageSize = APP_CONFIG.API_PAGE_SIZE;
if (page * pageSize > APP_CONFIG.API_MAX_WINDOW) {
  pageSize = Math.floor(APP_CONFIG.API_MAX_WINDOW / page);
}

// Page-based limits instead of transaction count
while (hasMore && page <= maxPages) {
  // Fetch up to configured page limit
}
```

## 🚨 Error Handling

The application handles various error scenarios:

1. **API Errors**: Rate limits, invalid keys, timeouts
2. **Storage Errors**: Quota exceeded, corrupt data
3. **Network Errors**: RPC connection issues
4. **Data Errors**: Invalid transaction formats

Error messages are displayed in the UI with actionable suggestions.

## 📈 Performance Considerations

- **Failed Transactions Only**: Reduces data volume by ~95%
- **Deployment Block Optimization**: Skips millions of empty blocks before contract deployment
- **Newest First Strategy**: Shows most relevant (recent) failures immediately
- **Page-Based Limits**: 100 pages initially, expandable on demand
- **API Window Optimization**: Dynamic page sizing to respect API limits
- **Compression**: Input data truncation saves ~40% storage
- **Pagination**: 50 transactions per page for smooth rendering
- **Limited Error Analysis**: Max 50 failed transactions analyzed per fetch for speed

## 🔮 Future Enhancements

- [ ] Add more chains (Ethereum Mainnet, Polygon, Arbitrum, etc.)
- [ ] Export functionality (CSV, JSON)
- [ ] Error categorization and statistics dashboard
- [ ] Real-time notifications for new failed transactions
- [ ] Custom contract address support with ABI upload
- [ ] Database backend for larger datasets and team sharing
- [ ] Advanced filtering (date ranges, gas price, value ranges)
- [ ] Error trend analysis and alerting

## 🤝 Contributing

Feel free to submit issues and enhancement requests!

## 📄 License

This project is open source. Please check the license file for details.

---

## 🔍 Troubleshooting

### Common Issues

1. **"No failed transactions found"**: Contract might not have any failed transactions in recent blocks
2. **"Storage quota exceeded"**: Clear data or reduce the number of contracts being monitored
3. **"API rate limit reached"**: Wait a few minutes before making more requests
4. **"Result window is too large"**: The app automatically handles this for Gnosis API limits
5. **"Query timeout"**: Reduce page limits in `APP_CONFIG` or contact API provider
6. **"Fetch More button disabled"**: You need to do an initial fetch first

### Debug Mode

Check browser console for detailed logs:
- API request/response details
- Storage operations
- Error analysis progress

For additional help, check the browser's Network tab to see actual API calls being made.
