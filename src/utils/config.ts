import {
  AppChainConfig,
  DEFAULT_CHAIN_CONFIGS,
  LEGACY_CHAIN_PRESETS,
  PRESET_TRACKED_CONTRACTS,
  TrackedContractConfig
} from '../constants';

export interface ConfigData {
  etherscanApiKey: string;
  chains: AppChainConfig[];
  trackedContracts: Record<string, TrackedContractConfig[]>;
}

const CONFIG_STORAGE_KEY = 'sc-stats-config';

const dedupeChains = (chains: AppChainConfig[]): AppChainConfig[] => {
  const seen = new Set<string>();

  return chains.filter((chain) => {
    if (!chain.id || seen.has(chain.id)) return false;
    seen.add(chain.id);
    return true;
  });
};

const dedupeContracts = (contracts: TrackedContractConfig[]): TrackedContractConfig[] => {
  const seen = new Set<string>();

  return contracts.filter((contract) => {
    if (!contract.id || seen.has(contract.id)) return false;
    seen.add(contract.id);
    return true;
  });
};

export const buildDefaultConfig = (): ConfigData => ({
  etherscanApiKey: '',
  chains: DEFAULT_CHAIN_CONFIGS.map((chain) => ({ ...chain })),
  trackedContracts: Object.fromEntries(
    Object.entries(PRESET_TRACKED_CONTRACTS)
      .filter(([chainId]) => DEFAULT_CHAIN_CONFIGS.some((chain) => chain.id === chainId))
      .map(([chainId, contracts]) => [
        chainId,
        contracts.map((contract) => ({ ...contract }))
      ])
  )
});

const sanitizeChain = (chain: Partial<AppChainConfig>): AppChainConfig | null => {
  if (!chain.id || !chain.name || !chain.chainId || !chain.explorerUrl) return null;

  return {
    id: chain.id,
    name: chain.name,
    chainId: Number(chain.chainId),
    explorerUrl: chain.explorerUrl,
    rpcUrl: chain.rpcUrl || '',
    isCustom: Boolean(chain.isCustom)
  };
};

const sanitizeContract = (contract: Partial<TrackedContractConfig>): TrackedContractConfig | null => {
  if (!contract.id || !contract.address || !contract.name) return null;

  return {
    id: contract.id,
    name: contract.name,
    address: contract.address,
    deploymentBlock: Number(contract.deploymentBlock || 0),
    abi: typeof contract.abi === 'string' ? contract.abi : null,
    isCustom: Boolean(contract.isCustom)
  };
};

const mergeTrackedContracts = (
  baseContracts: Record<string, TrackedContractConfig[]>,
  incomingContracts?: Record<string, Partial<TrackedContractConfig>[]>
): Record<string, TrackedContractConfig[]> => {
  const merged = Object.fromEntries(
    Object.entries(baseContracts).map(([chainId, contracts]) => [
      chainId,
      contracts.map((contract) => ({ ...contract }))
    ])
  ) as Record<string, TrackedContractConfig[]>;

  if (!incomingContracts) return merged;

  Object.entries(incomingContracts).forEach(([chainId, contracts]) => {
    const sanitized = contracts
      .map((contract) => sanitizeContract(contract))
      .filter((contract): contract is TrackedContractConfig => contract !== null);

    if (sanitized.length === 0) return;

    merged[chainId] = dedupeContracts([...(merged[chainId] || []), ...sanitized]);
  });

  return merged;
};

const migrateLegacyConfig = (parsed: Record<string, unknown>): ConfigData => {
  const defaultConfig = buildDefaultConfig();
  const etherscanApiKey =
    typeof parsed.etherscanApiKey === 'string'
      ? parsed.etherscanApiKey
      : typeof parsed.sepolia === 'object' &&
          parsed.sepolia !== null &&
          'apiKey' in parsed.sepolia &&
          typeof parsed.sepolia.apiKey === 'string'
        ? parsed.sepolia.apiKey
        : '';

  const chains = [...defaultConfig.chains];

  (['sepolia', 'gnosis'] as const).forEach((legacyChainId) => {
    const maybeLegacy = parsed[legacyChainId];
    if (!maybeLegacy || typeof maybeLegacy !== 'object') return;

    const rpcUrl = 'rpcUrl' in maybeLegacy && typeof maybeLegacy.rpcUrl === 'string'
      ? maybeLegacy.rpcUrl
      : LEGACY_CHAIN_PRESETS[legacyChainId].rpcUrl;

    const preset = LEGACY_CHAIN_PRESETS[legacyChainId];
    const index = chains.findIndex((chain) => chain.id === legacyChainId);
    if (index >= 0) {
      chains[index] = { ...chains[index], rpcUrl };
      return;
    }

    chains.push({
      ...preset,
      rpcUrl
    });
  });

  return {
    etherscanApiKey,
    chains: dedupeChains(chains),
    trackedContracts: mergeTrackedContracts(defaultConfig.trackedContracts, PRESET_TRACKED_CONTRACTS)
  };
};

const normalizeConfig = (parsed: unknown): ConfigData => {
  const defaultConfig = buildDefaultConfig();

  if (!parsed || typeof parsed !== 'object') {
    return defaultConfig;
  }

  const maybeConfig = parsed as Record<string, unknown>;
  if (!Array.isArray(maybeConfig.chains)) {
    return migrateLegacyConfig(maybeConfig);
  }

  const chains = dedupeChains(
    maybeConfig.chains
      .map((chain) => sanitizeChain(chain as Partial<AppChainConfig>))
      .filter((chain): chain is AppChainConfig => chain !== null)
  );

  const trackedContracts = mergeTrackedContracts(
    defaultConfig.trackedContracts,
    (maybeConfig.trackedContracts as Record<string, Partial<TrackedContractConfig>[]>) || {}
  );

  return {
    etherscanApiKey: typeof maybeConfig.etherscanApiKey === 'string' ? maybeConfig.etherscanApiKey : '',
    chains: chains.length > 0 ? chains : defaultConfig.chains,
    trackedContracts
  };
};

export const loadConfig = (): ConfigData | null => {
  if (typeof window === 'undefined') return null;

  try {
    const savedConfig = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!savedConfig) return buildDefaultConfig();
    return normalizeConfig(JSON.parse(savedConfig));
  } catch (error) {
    console.error('Error loading config:', error);
    return buildDefaultConfig();
  }
};

export const saveConfig = (config: ConfigData) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
};

export const isConfigValid = (config: ConfigData | null): boolean => {
  if (!config) return false;
  if (!config.etherscanApiKey.trim()) return false;

  return getConfiguredChains(config).length > 0;
};

export const getConfiguredChains = (config: ConfigData | null): AppChainConfig[] => {
  if (!config) return [];

  return config.chains.filter((chain) => chain.rpcUrl.trim());
};

export const getChainConfig = (chainId: string, config: ConfigData | null): AppChainConfig | null => {
  if (!config) return null;

  return config.chains.find((chain) => chain.id === chainId) || null;
};

export const getTrackedContractsForChain = (
  config: ConfigData | null,
  chainId: string
): TrackedContractConfig[] => {
  if (!config) return [];
  return config.trackedContracts[chainId] || [];
};

export const updateContractInConfig = (
  config: ConfigData,
  chainId: string,
  nextContract: TrackedContractConfig
): ConfigData => {
  const contracts = getTrackedContractsForChain(config, chainId);
  const index = contracts.findIndex((contract) => contract.id === nextContract.id);
  const updatedContracts = [...contracts];

  if (index >= 0) {
    updatedContracts[index] = nextContract;
  } else {
    updatedContracts.push(nextContract);
  }

  return {
    ...config,
    trackedContracts: {
      ...config.trackedContracts,
      [chainId]: dedupeContracts(updatedContracts)
    }
  };
};

export const removeContractFromConfig = (
  config: ConfigData,
  chainId: string,
  contractId: string
): ConfigData => ({
  ...config,
  trackedContracts: {
    ...config.trackedContracts,
    [chainId]: getTrackedContractsForChain(config, chainId).filter((contract) => contract.id !== contractId)
  }
});
