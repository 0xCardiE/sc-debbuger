// Etherscan API V2 - unified endpoint for supported scanner family chains
export const ETHERSCAN_API_V2_URL = 'https://api.etherscan.io/v2/api';

export interface AppChainConfig {
  id: string;
  name: string;
  chainId: number;
  explorerUrl: string;
  rpcUrl: string;
  isCustom?: boolean;
}

export interface TrackedContractConfig {
  id: string;
  name: string;
  address: string;
  deploymentBlock: number;
  abi?: string | null;
  isCustom?: boolean;
}

export const DEFAULT_CHAIN_CONFIGS: AppChainConfig[] = [
  {
    id: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    explorerUrl: 'https://etherscan.io',
    rpcUrl: 'https://ethereum-rpc.publicnode.com'
  },
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    explorerUrl: 'https://basescan.org',
    rpcUrl: 'https://base-rpc.publicnode.com'
  },
  {
    id: 'gnosis',
    name: 'Gnosis',
    chainId: 100,
    explorerUrl: 'https://gnosisscan.io',
    rpcUrl: 'https://rpc.gnosischain.com'
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum',
    chainId: 42161,
    explorerUrl: 'https://arbiscan.io',
    rpcUrl: 'https://arbitrum-one-rpc.publicnode.com'
  }
];

export const LEGACY_CHAIN_PRESETS: Record<string, AppChainConfig> = {
  sepolia: {
    id: 'sepolia',
    name: 'Sepolia',
    chainId: 11155111,
    explorerUrl: 'https://sepolia.etherscan.io',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com'
  },
  gnosis: DEFAULT_CHAIN_CONFIGS.find((chain) => chain.id === 'gnosis')!
};

export const PRESET_TRACKED_CONTRACTS: Record<string, TrackedContractConfig[]> = {
  ethereum: [
    {
      id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      name: 'WETH9',
      address: '0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2',
      deploymentBlock: 0
    },
    {
      id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      name: 'USDC',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      deploymentBlock: 0
    },
    {
      id: '0x000000000022d473030f116ddee9f6b43ac78ba3',
      name: 'Uniswap Permit2',
      address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      deploymentBlock: 0
    },
    {
      id: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
      name: 'Uniswap Universal Router V2',
      address: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
      deploymentBlock: 0
    },
    {
      id: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
      name: 'Aave V3 Pool',
      address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
      deploymentBlock: 0
    }
  ],
  gnosis: [
    {
      id: '0x5069cdfb3d9e56d23b1caee83ce6109a7e4fd62d',
      name: 'Redistribution',
      address: '0x5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d',
      deploymentBlock: 37339181
    },
    {
      id: '0x47eef336e7fe5bed98499a4696bce8f28c1b0a8b',
      name: 'PriceOracle',
      address: '0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b',
      deploymentBlock: 37339168
    },
    {
      id: '0x45a1502382541cd610cc9068e88727426b696293',
      name: 'PostageStamp',
      address: '0x45a1502382541Cd610CC9068e88727426b696293',
      deploymentBlock: 31305656
    },
    {
      id: '0xda2a16ee889e7f04980a8d597b48c8d51b9518f4',
      name: 'Staking',
      address: '0xda2a16EE889E7F04980A8d597b48c8D51B9518F4',
      deploymentBlock: 37339175
    }
  ],
  sepolia: [
    {
      id: '0x543ddb01ba47acb11de34891cd86b675f04840db',
      name: 'BzzToken',
      address: '0x543dDb01Ba47acB11de34891cD86B675F04840db',
      deploymentBlock: 0
    },
    {
      id: '0x5b718e36f5ce2f2f7e25a397040436ce6af3e89e',
      name: 'Redistribution',
      address: '0x5b718E36F5Ce2F2F7e25A397040436Ce6af3e89e',
      deploymentBlock: 0
    },
    {
      id: '0xcdfdc3752caaa826fe62531e0000c40546ec56a6',
      name: 'PostageStamp',
      address: '0xcdfdC3752caaA826fE62531E0000C40546eC56A6',
      deploymentBlock: 6596277
    },
    {
      id: '0x95dc18380e92c13e4f8a4e94c99fb1b97250174b',
      name: 'PriceOracle',
      address: '0x95Dc18380e92C13E4F8a4e94C99FB1b97250174B',
      deploymentBlock: 8226873
    },
    {
      id: '0xeef13ef9ed9cdd169701eef3cd832df298dd1bb4',
      name: 'Staking',
      address: '0xEEF13Ef9eD9cDD169701eeF3cd832df298dD1bB4',
      deploymentBlock: 8262529
    }
  ]
};

export const APP_CONFIG = {
  MAX_FAILED_TRANSACTIONS: 2000,
  TRANSACTIONS_PER_PAGE: 50,
  API_PAGE_SIZE: 10000,
  API_MAX_WINDOW: 10000,
  INITIAL_PAGES_TO_FETCH: 100,
  ADDITIONAL_PAGES_TO_FETCH: 100,
  MAX_TRANSACTIONS_TO_ANALYZE: 2000,
  API_DELAY_MS: 600,
  RPC_DELAY_MS: 100,
  STORAGE_COMPRESSION_ENABLED: true,
  ERROR_TRUNCATE_LENGTH: 80,
  HASH_TRUNCATE_LENGTH: 18,
  ADDRESS_TRUNCATE_LENGTH: 10
} as const;
