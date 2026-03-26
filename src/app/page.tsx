'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { decodeError, getContractErrors, matchErrorSelector } from '../errorMappings';
import {
  APP_CONFIG,
  AppChainConfig,
  ETHERSCAN_API_V2_URL,
  TrackedContractConfig
} from '../constants';
import {
  ConfigData,
  getChainConfig,
  getConfiguredChains,
  getTrackedContractsForChain,
  isConfigValid,
  loadConfig,
  removeContractFromConfig,
  saveConfig,
  updateContractInConfig
} from '../utils/config';
import ConfigModal from '../components/ConfigModal';

interface Transaction {
  hash: string;
  blockNumber: number;
  from: string;
  to: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  timestamp: number;
  isError: string;
  txreceipt_status: string;
  input: string;
  methodId: string;
  functionName: string;
  errorReason?: string;
  errorName?: string;
  errorDataRaw?: string;
  errorSelector?: string;
  decodedErrorSignature?: string;
  errorDecodeStatus?: string;
  errorProbeSource?: string;
  errorDebugRaw?: string;
  sourceLocationStatus?: string;
  sourceLocationMatches?: string[];
  traceStatus?: string;
  traceSummary?: string[];
}

interface EtherscanTransaction {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasPrice: string;
  isError: string;
  txreceipt_status: string;
  input: string;
  gasUsed: string;
  methodId: string;
  functionName: string;
}

interface StoredContractData {
  transactions: Transaction[];
  lastUpdatedBlock: number;
  pagesFetched: number;
}

interface StoredData {
  [chainId: string]: {
    [contractId: string]: StoredContractData;
  };
}

interface VerifiedSourceFile {
  path: string;
  content: string;
}

interface VerifiedSourceBundle {
  contractName: string;
  files: VerifiedSourceFile[];
}

interface TraceCallFrame {
  type?: string;
  from?: string;
  to?: string;
  input?: string;
  output?: string;
  error?: string;
  revertReason?: string;
  calls?: TraceCallFrame[];
}

const getStorageKey = (
  chainId: string,
  contractId: string,
  type: 'transactions' | 'block' | 'pages'
) => `${chainId}_${contractId}_${type}`;

const HEX_PATTERN = /0x[a-fA-F0-9]{8,}/g;
const ADDRESS_HEX_LENGTH = 42;
const SELECTOR_HEX_LENGTH = 10;
const REVERT_DATA_FIELD_NAMES = new Set([
  'data',
  'errordata',
  'revertdata',
  'result',
  'output',
  'returndata',
  'payload',
  'body'
]);

const normalizeHexCandidate = (value: string): string | null => {
  const normalized = value.toLowerCase();
  if (!normalized.startsWith('0x')) return null;
  if (!/^0x[a-f0-9]+$/.test(normalized)) return null;
  return normalized;
};

const isLikelyAddress = (value: string): boolean => value.length === ADDRESS_HEX_LENGTH;

const collectHexStrings = (
  value: unknown,
  acc: Array<{ value: string; path: string }>,
  path = 'root',
  seen = new WeakSet<object>()
) => {
  if (typeof value === 'string') {
    const matches = value.match(HEX_PATTERN);
    if (matches) {
      matches.forEach((match) => {
        const normalized = normalizeHexCandidate(match);
        if (normalized) acc.push({ value: normalized, path });
      });
    }
    return;
  }

  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectHexStrings(item, acc, `${path}[${index}]`, seen));
    return;
  }

  Object.entries(value).forEach(([key, item]) => {
    collectHexStrings(item, acc, `${path}.${key.toLowerCase()}`, seen);
  });
};

const scoreHexCandidate = (candidate: { value: string; path: string }): number => {
  let score = 0;
  const pathParts = candidate.path.split('.');

  if (candidate.value.length > ADDRESS_HEX_LENGTH) score += 20;
  if (candidate.value.length === SELECTOR_HEX_LENGTH) score += 5;
  if (isLikelyAddress(candidate.value)) score -= 30;

  if (pathParts.some((part) => REVERT_DATA_FIELD_NAMES.has(part))) score += 50;
  if (candidate.path.includes('error')) score += 15;
  if (candidate.path.includes('message')) score -= 10;

  return score;
};

const extractHexCandidates = (error: unknown): string[] => {
  const candidates: Array<{ value: string; path: string }> = [];
  collectHexStrings(error, candidates);

  return [...new Map(
    candidates
      .sort((left, right) => scoreHexCandidate(right) - scoreHexCandidate(left))
      .map((candidate) => [candidate.value, candidate.value])
  ).values()];
};

const extractErrorData = (error: unknown): string | null => {
  const candidates = extractHexCandidates(error);
  return candidates.find(
    (candidate) => candidate.length > SELECTOR_HEX_LENGTH && !isLikelyAddress(candidate)
  ) || null;
};

const extractErrorSelector = (error: unknown): string | null => {
  const candidates = extractHexCandidates(error);
  return candidates
    .filter((candidate) => !isLikelyAddress(candidate))
    .map((candidate) => candidate.slice(0, SELECTOR_HEX_LENGTH))
    .find((candidate) => candidate.length === SELECTOR_HEX_LENGTH) || null;
};

const getErrorText = (error: unknown): string => {
  if (!error || typeof error !== 'object') return '';

  const maybeError = error as {
    reason?: string;
    shortMessage?: string;
    message?: string;
  };

  return [maybeError.reason, maybeError.shortMessage, maybeError.message]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' | ')
    .toLowerCase();
};

const isTraceFrameFailing = (frame: TraceCallFrame | null | undefined): boolean => {
  if (!frame) return false;
  return Boolean(frame.error || frame.revertReason || (frame.output && frame.output !== '0x'));
};

const findDeepestFailingTraceFrame = (frame: TraceCallFrame | null | undefined): TraceCallFrame | null => {
  if (!frame) return null;

  for (const child of frame.calls || []) {
    const failingChild = findDeepestFailingTraceFrame(child);
    if (failingChild) return failingChild;
  }

  return isTraceFrameFailing(frame) ? frame : null;
};

const buildTraceSummary = (frame: TraceCallFrame | null | undefined): string[] => {
  if (!frame) return [];

  const summary: string[] = [];
  let current: TraceCallFrame | undefined | null = frame;

  while (current) {
    const parts = [
      current.type || 'CALL',
      current.to || 'unknown-target',
      current.revertReason || current.error || ''
    ].filter(Boolean);
    summary.push(parts.join(' - '));
    current = current.calls && current.calls.length > 0 ? current.calls[0] : null;
  }

  return summary.slice(0, 5);
};

const safeStringifyError = (error: unknown): string => {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      error,
      (_, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        return value;
      },
      2
    );
  } catch {
    return String(error);
  }
};

const summarizeTraceError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('no state available for block')) {
    return 'Trace unavailable: RPC lacks historical state for this block. Using fallback replay instead.';
  }

  if (lowerMessage.includes('method not found') || lowerMessage.includes('-32601')) {
    return 'Trace unavailable: RPC does not support debug tracing. Using fallback replay instead.';
  }

  if (lowerMessage.includes('missing trie node')) {
    return 'Trace unavailable: RPC is missing required archive state. Using fallback replay instead.';
  }

  return 'Trace unavailable: RPC could not provide a transaction trace. Using fallback replay instead.';
};

const hasUsefulRevertData = (error: unknown): boolean => {
  const errorData = extractErrorData(error);
  return Boolean(errorData && errorData.startsWith('0x') && errorData.length >= 10);
};

const needsErrorAnalysis = (tx: Transaction): boolean => {
  if (!tx.errorReason) return true;
  if (!tx.errorName) return true;
  if (tx.errorName === 'UNKNOWN_ERROR') return true;
  if (tx.errorReason.toLowerCase().includes('missing revert data')) return true;
  if (tx.errorName === 'CALL_EXCEPTION' && !tx.errorDataRaw) return true;
  if (!tx.errorSelector && tx.errorDataRaw) return true;
  return false;
};

const getErrorBaseName = (errorName?: string): string | null => {
  if (!errorName) return null;
  const match = errorName.match(/^([A-Za-z0-9_]+)/);
  if (!match) return null;
  const baseName = match[1];
  if (baseName === 'Error' || baseName === 'Panic' || baseName === 'CALL_EXCEPTION') return null;
  if (baseName.startsWith('0x')) return null;
  return baseName;
};

const getMethodBaseName = (functionName?: string): string | null => {
  if (!functionName || functionName === 'Unknown' || functionName === 'N/A') return null;
  const match = functionName.match(/^([A-Za-z0-9_]+)/);
  return match ? match[1] : null;
};

const parseVerifiedSourceCode = (
  sourceCode: string,
  contractName: string
): VerifiedSourceBundle | null => {
  if (!sourceCode.trim()) return null;

  const normalized = sourceCode.trim();
  const tryParseJson = (value: string) => {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const parsedJson =
    tryParseJson(normalized) ||
    (normalized.startsWith('{{') && normalized.endsWith('}}')
      ? tryParseJson(normalized.slice(1, -1))
      : null);

  if (parsedJson && parsedJson.sources && typeof parsedJson.sources === 'object') {
    const files = Object.entries(parsedJson.sources as Record<string, unknown>)
      .map(([path, sourceEntry]) => {
        if (
          sourceEntry &&
          typeof sourceEntry === 'object' &&
          'content' in sourceEntry &&
          typeof sourceEntry.content === 'string'
        ) {
          return {
            path,
            content: sourceEntry.content
          };
        }
        return null;
      })
      .filter((file): file is VerifiedSourceFile => file !== null);

    if (files.length > 0) {
      return {
        contractName,
        files
      };
    }
  }

  return {
    contractName,
    files: [
      {
        path: `${contractName || 'Contract'}.sol`,
        content: sourceCode
      }
    ]
  };
};

const extractFunctionBlocks = (
  file: VerifiedSourceFile,
  methodName: string
): Array<{ path: string; startLine: number; endLine: number; content: string }> => {
  const content = file.content;
  const regex = new RegExp(`\\bfunction\\s+${methodName}\\s*\\(`, 'g');
  const blocks: Array<{ path: string; startLine: number; endLine: number; content: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const startIndex = match.index;
    const braceStart = content.indexOf('{', startIndex);
    if (braceStart === -1) continue;

    let depth = 0;
    let endIndex = braceStart;
    for (let i = braceStart; i < content.length; i += 1) {
      if (content[i] === '{') depth += 1;
      if (content[i] === '}') depth -= 1;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }

    const blockContent = content.slice(startIndex, endIndex + 1);
    const startLine = content.slice(0, startIndex).split('\n').length;
    const endLine = startLine + blockContent.split('\n').length - 1;

    blocks.push({
      path: file.path,
      startLine,
      endLine,
      content: blockContent
    });
  }

  return blocks;
};

const extractDeclaredErrors = (sourceBundle: VerifiedSourceBundle | null): Array<{
  name: string;
  signature: string;
  selector: string;
  declaration: string;
  path: string;
  line: number;
}> => {
  if (!sourceBundle) return [];

  const declarations: Array<{
    name: string;
    signature: string;
    selector: string;
    declaration: string;
    path: string;
    line: number;
  }> = [];

  sourceBundle.files.forEach((file) => {
    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      const match = line.match(/\berror\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*;/);
      if (!match) return;

      const name = match[1];
      const params = match[2]
        .split(',')
        .map((param) => param.trim())
        .filter(Boolean)
        .map((param) => param.split(/\s+/)[0]);
      const signature = `${name}(${params.join(',')})`;

      declarations.push({
        name,
        signature,
        selector: ethers.id(signature).slice(0, 10).toLowerCase(),
        declaration: line.trim(),
        path: file.path,
        line: index + 1
      });
    });
  });

  return declarations;
};

const findLikelySourceLocations = (
  sourceBundle: VerifiedSourceBundle | null,
  functionName?: string,
  errorSelector?: string,
  errorName?: string,
  errorReason?: string
): string[] => {
  if (!sourceBundle) return [];

  const methodBaseName = getMethodBaseName(functionName);
  const errorBaseName = getErrorBaseName(errorName);
  const reasonStringMatch = errorReason?.match(/^Error\((.*)\)$/);
  const reasonString = reasonStringMatch?.[1] || '';
  const normalizedSelector = errorSelector?.toLowerCase();
  const declaredErrors = extractDeclaredErrors(sourceBundle);
  const candidates: Array<{ label: string; score: number }> = [];

  const addCandidate = (label: string, score: number) => {
    candidates.push({ label, score });
  };

  if (methodBaseName) {
    sourceBundle.files.forEach((file) => {
      const blocks = extractFunctionBlocks(file, methodBaseName);

      blocks.forEach((block) => {
        const blockLines = block.content.split('\n');

        blockLines.forEach((line, index) => {
          const absoluteLine = block.startLine + index;
          const trimmedLine = line.trim();

          if (errorBaseName && new RegExp(`\\brevert\\s+${errorBaseName}\\s*\\(`).test(trimmedLine)) {
            addCandidate(`${block.path}:${absoluteLine} - ${trimmedLine}`, 200);
          }

          if (reasonString && trimmedLine.includes(reasonString)) {
            addCandidate(`${block.path}:${absoluteLine} - ${trimmedLine}`, 180);
          }

          const referencedErrorNames = Array.from(trimmedLine.matchAll(/\brevert\s+([A-Za-z0-9_]+)\s*\(/g))
            .map((match) => match[1]);

          referencedErrorNames.forEach((referencedErrorName) => {
            const declaration = declaredErrors.find((item) => item.name === referencedErrorName);
            if (!declaration) return;

            if (normalizedSelector && declaration.selector === normalizedSelector) {
              addCandidate(
                `${block.path}:${absoluteLine} - ${trimmedLine} [selector match ${normalizedSelector}]`,
                250
              );
            } else if (errorBaseName && declaration.name === errorBaseName) {
              addCandidate(`${block.path}:${absoluteLine} - ${trimmedLine}`, 190);
            }
          });
        });
      });
    });
  }

  declaredErrors.forEach((declaration) => {
    if (normalizedSelector && declaration.selector === normalizedSelector) {
      addCandidate(
        `${declaration.path}:${declaration.line} - ${declaration.declaration} [error declaration ${declaration.selector}]`,
        120
      );
    } else if (errorBaseName && declaration.name === errorBaseName) {
      addCandidate(
        `${declaration.path}:${declaration.line} - ${declaration.declaration}`,
        60
      );
    }
  });

  sourceBundle.files.forEach((file) => {
    const lines = file.content.split('\n');

    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      const trimmedLine = line.trim();

      if (errorBaseName) {
        if (new RegExp(`\\brevert\\s+${errorBaseName}\\s*\\(`).test(trimmedLine)) {
          addCandidate(`${file.path}:${lineNumber} - ${trimmedLine}`, 100);
          return;
        }

        if (new RegExp(`\\berror\\s+${errorBaseName}\\s*\\(`).test(trimmedLine)) {
          addCandidate(`${file.path}:${lineNumber} - ${trimmedLine}`, 30);
        }
      }

      if (reasonString && trimmedLine.includes(reasonString)) {
        addCandidate(`${file.path}:${lineNumber} - ${trimmedLine}`, 80);
      }
    });
  });

  return [...new Map(
    candidates
      .sort((left, right) => right.score - left.score)
      .map((candidate) => [candidate.label, candidate.label])
  ).values()].slice(0, 3);
};

export default function Home() {
  const [selectedChain, setSelectedChain] = useState('');
  const [selectedContract, setSelectedContract] = useState('');
  const [failedTransactions, setFailedTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedBlock, setLastUpdatedBlock] = useState<number>(0);
  const [currentProgress, setCurrentProgress] = useState('');
  const [pagesFetched, setPagesFetched] = useState(0);
  const [isClient, setIsClient] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [storedDataSummary, setStoredDataSummary] = useState<StoredData>({});
  const [selectedErrorFilter, setSelectedErrorFilter] = useState('all');
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configValid, setConfigValid] = useState(false);
  const [showAddContractForm, setShowAddContractForm] = useState(false);
  const [newContractName, setNewContractName] = useState('');
  const [newContractAddress, setNewContractAddress] = useState('');
  const [newContractDeploymentBlock, setNewContractDeploymentBlock] = useState('');
  const configRef = useRef<ConfigData | null>(null);
  const sourceBundleCacheRef = useRef<Record<string, VerifiedSourceBundle | null>>({});
  const abiCacheRef = useRef<Record<string, string | null>>({});

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    setIsClient(true);
    const savedConfig = loadConfig();
    setConfig(savedConfig);
    setConfigValid(isConfigValid(savedConfig));
  }, []);

  const configuredChains = useMemo(() => getConfiguredChains(config), [config]);
  const currentChainConfig = useMemo(
    () => getChainConfig(selectedChain, config),
    [config, selectedChain]
  );
  const trackedContracts = useMemo(
    () => getTrackedContractsForChain(config, selectedChain),
    [config, selectedChain]
  );
  const currentContractConfig = useMemo(
    () => trackedContracts.find((contract) => contract.id === selectedContract) || null,
    [trackedContracts, selectedContract]
  );

  const applyConfigUpdate = (updater: (prev: ConfigData) => ConfigData) => {
    const current = configRef.current;
    if (!current) return;

    const next = updater(current);
    saveConfig(next);
    configRef.current = next;
    setConfig(next);
    setConfigValid(isConfigValid(next));
  };

  useEffect(() => {
    if (!isClient || !config) return;

    if (configuredChains.length === 0) {
      setSelectedChain('');
      setSelectedContract('');
      return;
    }

    if (!configuredChains.some((chain) => chain.id === selectedChain)) {
      setSelectedChain(configuredChains[0].id);
      return;
    }

    const chainContracts = getTrackedContractsForChain(config, selectedChain);
    if (chainContracts.length === 0) {
      if (selectedContract !== '') setSelectedContract('');
      return;
    }

    if (!chainContracts.some((contract) => contract.id === selectedContract)) {
      setSelectedContract(chainContracts[0].id);
    }
  }, [config, configuredChains, isClient, selectedChain, selectedContract]);

  useEffect(() => {
    if (!isClient || !config) return;
    loadStoredDataSummary(config);
  }, [config, isClient]);

  useEffect(() => {
    if (!isClient) return;
    loadCurrentContractData(selectedChain, selectedContract);
    setCurrentPage(1);
  }, [isClient, selectedChain, selectedContract]);

  const loadStoredDataSummary = (currentConfig: ConfigData) => {
    if (typeof window === 'undefined') return;

    const summary: StoredData = {};

    getConfiguredChains(currentConfig).forEach((chain) => {
      const chainContracts = getTrackedContractsForChain(currentConfig, chain.id);
      summary[chain.id] = {};

      chainContracts.forEach((contract) => {
        const transactionsKey = getStorageKey(chain.id, contract.id, 'transactions');
        const blockKey = getStorageKey(chain.id, contract.id, 'block');
        const pagesKey = getStorageKey(chain.id, contract.id, 'pages');

        try {
          const storedTransactions = localStorage.getItem(transactionsKey);
          const storedBlock = localStorage.getItem(blockKey);
          const storedPages = localStorage.getItem(pagesKey);

          summary[chain.id][contract.id] = {
            transactions: storedTransactions ? JSON.parse(storedTransactions) : [],
            lastUpdatedBlock: storedBlock ? parseInt(storedBlock, 10) : 0,
            pagesFetched: storedPages ? parseInt(storedPages, 10) : 0
          };
        } catch (err) {
          console.error(`Error loading data for ${chain.id}/${contract.id}:`, err);
          summary[chain.id][contract.id] = {
            transactions: [],
            lastUpdatedBlock: 0,
            pagesFetched: 0
          };
        }
      });
    });

    setStoredDataSummary(summary);
  };

  const loadCurrentContractData = (chainId: string, contractId: string) => {
    if (typeof window === 'undefined') return;
    if (!chainId || !contractId) {
      setFailedTransactions([]);
      setLastUpdatedBlock(0);
      setPagesFetched(0);
      return;
    }

    try {
      const transactionsKey = getStorageKey(chainId, contractId, 'transactions');
      const blockKey = getStorageKey(chainId, contractId, 'block');
      const pagesKey = getStorageKey(chainId, contractId, 'pages');

      const storedTransactions = localStorage.getItem(transactionsKey);
      const storedBlock = localStorage.getItem(blockKey);
      const storedPages = localStorage.getItem(pagesKey);

      setFailedTransactions(storedTransactions ? JSON.parse(storedTransactions) : []);
      setLastUpdatedBlock(storedBlock ? parseInt(storedBlock, 10) : 0);
      setPagesFetched(storedPages ? parseInt(storedPages, 10) : 0);
      setError(null);
    } catch (err) {
      console.error('Error loading contract data:', err);
      setError('Error loading stored data for this contract.');
    }
  };

  const compressData = (data: Transaction[]): string => {
    try {
      return JSON.stringify(data, (key, value) => {
        if (key === 'input' && typeof value === 'string' && value.length > 100) {
          return `${value.substring(0, 100)}...`;
        }
        return value;
      });
    } catch (err) {
      console.error('Compression error:', err);
      return JSON.stringify(data);
    }
  };

  const saveCurrentContractData = (
    chainId: string,
    contractId: string,
    transactions: Transaction[],
    lastBlock: number,
    pages: number
  ) => {
    if (typeof window === 'undefined') return;

    try {
      const transactionsKey = getStorageKey(chainId, contractId, 'transactions');
      const blockKey = getStorageKey(chainId, contractId, 'block');
      const pagesKey = getStorageKey(chainId, contractId, 'pages');
      const compressedData = compressData(transactions);
      const sizeInMB = (compressedData.length * 2) / 1024 / 1024;

      if (sizeInMB > 4) {
        const recentTransactions = transactions
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 1000);
        localStorage.setItem(transactionsKey, compressData(recentTransactions));
        setError(`Data was trimmed to the latest 1000 failed transactions (${sizeInMB.toFixed(2)} MB).`);
      } else {
        localStorage.setItem(transactionsKey, compressedData);
      }

      localStorage.setItem(blockKey, String(lastBlock));
      localStorage.setItem(pagesKey, String(pages));
      if (configRef.current) loadStoredDataSummary(configRef.current);
    } catch (err) {
      console.error('Error saving contract data:', err);
      setError('Error saving data to storage.');
    }
  };

  const deleteStoredContractData = (chainId: string, contractId: string) => {
    localStorage.removeItem(getStorageKey(chainId, contractId, 'transactions'));
    localStorage.removeItem(getStorageKey(chainId, contractId, 'block'));
    localStorage.removeItem(getStorageKey(chainId, contractId, 'pages'));
  };

  const persistContractAbi = (chainId: string, contractId: string, abi: string) => {
    applyConfigUpdate((prev) => {
      const chainContracts = getTrackedContractsForChain(prev, chainId);
      const contract = chainContracts.find((item) => item.id === contractId);
      if (!contract) return prev;

      return updateContractInConfig(prev, chainId, {
        ...contract,
        abi
      });
    });
  };

  const fetchContractAbi = async (
    chain: AppChainConfig,
    contract: TrackedContractConfig
  ): Promise<string | null> => {
    return fetchAbiForAddress(chain, contract.address, contract);
  };

  const fetchAbiForAddress = async (
    chain: AppChainConfig,
    address: string,
    trackedContract?: TrackedContractConfig | null
  ): Promise<string | null> => {
    const cacheKey = `${chain.id}:${address.toLowerCase()}`;
    if (cacheKey in abiCacheRef.current) {
      return abiCacheRef.current[cacheKey];
    }

    if (trackedContract?.abi) {
      abiCacheRef.current[cacheKey] = trackedContract.abi;
      return trackedContract.abi;
    }

    if (!configRef.current?.etherscanApiKey) {
      abiCacheRef.current[cacheKey] = null;
      return null;
    }

    try {
      const url = `${ETHERSCAN_API_V2_URL}?chainid=${chain.chainId}&module=contract&action=getabi&address=${address}&apikey=${configRef.current.etherscanApiKey}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.status === '1' && typeof data.result === 'string' && data.result.startsWith('[')) {
        abiCacheRef.current[cacheKey] = data.result;
        if (trackedContract && trackedContract.address.toLowerCase() === address.toLowerCase()) {
          persistContractAbi(chain.id, trackedContract.id, data.result);
        }
        return data.result;
      }
    } catch (err) {
      console.warn(`Unable to fetch ABI for ${address}:`, err);
    }

    abiCacheRef.current[cacheKey] = null;
    return null;
  };

  const fetchContractSourceBundle = async (
    chain: AppChainConfig,
    contract: TrackedContractConfig
  ): Promise<VerifiedSourceBundle | null> => {
    return fetchSourceBundleForAddress(chain, contract.address, contract.name);
  };

  const fetchSourceBundleForAddress = async (
    chain: AppChainConfig,
    address: string,
    fallbackName: string
  ): Promise<VerifiedSourceBundle | null> => {
    const cacheKey = `${chain.id}:${address.toLowerCase()}`;
    if (cacheKey in sourceBundleCacheRef.current) {
      return sourceBundleCacheRef.current[cacheKey];
    }

    if (!configRef.current?.etherscanApiKey) {
      sourceBundleCacheRef.current[cacheKey] = null;
      return null;
    }

    try {
      const url =
        `${ETHERSCAN_API_V2_URL}?chainid=${chain.chainId}` +
        `&module=contract&action=getsourcecode&address=${address}` +
        `&apikey=${configRef.current.etherscanApiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      const result = Array.isArray(data.result) ? data.result[0] : null;

      if (!result || typeof result.SourceCode !== 'string') {
        sourceBundleCacheRef.current[cacheKey] = null;
        return null;
      }

      const bundle = parseVerifiedSourceCode(
        result.SourceCode,
        typeof result.ContractName === 'string' ? result.ContractName : fallbackName
      );
      sourceBundleCacheRef.current[cacheKey] = bundle;
      return bundle;
    } catch (err) {
      console.warn(`Unable to fetch source code for ${address}:`, err);
      sourceBundleCacheRef.current[cacheKey] = null;
      return null;
    }
  };

  const analyzeFailedTransactions = async (
    chain: AppChainConfig,
    contract: TrackedContractConfig,
    failedTxs: Transaction[]
  ) => {
    if (failedTxs.length === 0) return;

    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const abi = await fetchContractAbi(chain, contract);
    const sourceBundle = await fetchContractSourceBundle(chain, contract);

    for (let i = 0; i < failedTxs.length; i += 1) {
      const tx = failedTxs[i];
      const progressPercent = Math.round(((i + 1) / failedTxs.length) * 100);
      setCurrentProgress(`Analyzing error details... ${i + 1}/${failedTxs.length} (${progressPercent}%)`);
      let decodeAddress = contract.address;
      let decodeAbi = abi;
      let decodeSourceBundle = sourceBundle;
      let traceSummary: string[] = [];

      try {
        const txDetails = await provider.getTransaction(tx.hash);
        const gasUsed = Number(tx.gasUsed);
        const gasLimit = txDetails ? Number(txDetails.gasLimit) : 0;
        const blockTag = tx.blockNumber > 0 ? BigInt(tx.blockNumber - 1) : undefined;

        if (gasUsed > 0 && gasLimit > 0 && gasUsed >= gasLimit * 0.99) {
          tx.errorReason = 'Out of gas - transaction consumed all available gas';
          tx.errorName = 'OUT_OF_GAS';
          tx.decodedErrorSignature = 'OutOfGas()';
          tx.traceStatus = 'Not needed - out of gas identified from receipt';
          continue;
        }

        const transactionRequest = {
          to: txDetails?.to || tx.to,
          data: txDetails?.data || tx.input,
          from: txDetails?.from || tx.from,
          value: txDetails?.value ?? BigInt(tx.value),
          gasPrice: txDetails?.gasPrice ?? undefined,
          gasLimit: txDetails?.gasLimit ?? undefined,
          maxFeePerGas: txDetails?.maxFeePerGas ?? undefined,
          maxPriorityFeePerGas: txDetails?.maxPriorityFeePerGas ?? undefined,
          accessList: txDetails?.accessList ?? undefined
        };

        const rawCallRequest = {
          to: transactionRequest.to,
          data: transactionRequest.data,
          from: transactionRequest.from,
          value: ethers.toQuantity(transactionRequest.value),
          gasPrice: transactionRequest.gasPrice ? ethers.toQuantity(transactionRequest.gasPrice) : undefined,
          gas: transactionRequest.gasLimit ? ethers.toQuantity(transactionRequest.gasLimit) : undefined,
          maxFeePerGas: transactionRequest.maxFeePerGas
            ? ethers.toQuantity(transactionRequest.maxFeePerGas)
            : undefined,
          maxPriorityFeePerGas: transactionRequest.maxPriorityFeePerGas
            ? ethers.toQuantity(transactionRequest.maxPriorityFeePerGas)
            : undefined,
          accessList: transactionRequest.accessList ?? undefined
        };

        let bestError: unknown = null;
        let bestErrorProbe = 'none';

        const preferError = (candidate: unknown, source: string) => {
          if (!candidate) return;
          const candidateHasHex = hasUsefulRevertData(candidate);
          const bestHasHex = hasUsefulRevertData(bestError);
          const candidateText = getErrorText(candidate);
          const bestText = getErrorText(bestError);

          const candidateScore =
            (candidateHasHex ? 100 : 0) +
            (candidateText.includes('execution reverted') ? 20 : 0) +
            (candidateText.includes('panic') ? 10 : 0) +
            (candidateText.includes('missing revert data') ? -20 : 0);
          const bestScore =
            (bestHasHex ? 100 : 0) +
            (bestText.includes('execution reverted') ? 20 : 0) +
            (bestText.includes('panic') ? 10 : 0) +
            (bestText.includes('missing revert data') ? -20 : 0);

          if (bestError === null || candidateScore > bestScore) {
            bestError = candidate;
            bestErrorProbe = source;
          }
        };

        try {
          const trace = await provider.send('debug_traceTransaction', [
            tx.hash,
            {
              tracer: 'callTracer'
            }
          ]) as TraceCallFrame;
          const failingFrame = findDeepestFailingTraceFrame(trace);

          if (failingFrame) {
            preferError(failingFrame, 'debug_traceTransaction');
            traceSummary = buildTraceSummary(failingFrame);

            if (failingFrame.to && ethers.isAddress(failingFrame.to)) {
              decodeAddress = ethers.getAddress(failingFrame.to);
              decodeAbi = await fetchAbiForAddress(chain, decodeAddress, null);
              decodeSourceBundle = await fetchSourceBundleForAddress(
                chain,
                decodeAddress,
                decodeAddress
              );
            }
          }
        } catch (traceError) {
          traceSummary = [summarizeTraceError(traceError)];
        }

        if (blockTag !== undefined) {
          try {
            await provider.send('eth_call', [rawCallRequest, ethers.toQuantity(blockTag)]);
          } catch (errorAtHistoricalBlock) {
            preferError(errorAtHistoricalBlock, 'eth_call@historical');
          }
        }

        try {
          await provider.call(transactionRequest);
        } catch (latestStateError) {
          preferError(latestStateError, 'provider.call@latest');
        }

        try {
          await provider.estimateGas(transactionRequest);
        } catch (estimateGasError) {
          preferError(estimateGasError, 'estimateGas');
        }

        if (!bestError) {
          tx.errorReason = 'Transaction failed due to state changes or gas estimation.';
          tx.errorName = 'STATE_DEPENDENT_FAILURE';
          tx.decodedErrorSignature = 'StateDependentFailure()';
          tx.errorDecodeStatus = 'No RPC error payload returned';
          tx.errorProbeSource = 'none';
          tx.traceStatus = traceSummary.length > 0 ? 'Trace checked but did not return a failing frame' : 'Trace unavailable';
          tx.traceSummary = traceSummary;
          continue;
        }

        (bestError as { __probeSource?: string }).__probeSource = bestErrorProbe;
        throw bestError;
      } catch (callError) {
        const errorData = extractErrorData(callError);
        const errorSelector = extractErrorSelector(callError);
        const decodedError =
          (errorData ? decodeError(errorData, decodeAddress, decodeAbi) : null) ||
          (errorSelector ? matchErrorSelector(errorSelector, decodeAddress, decodeAbi) : null);
        const error = callError as {
          code?: string;
          reason?: string;
          message?: string;
          shortMessage?: string;
          __probeSource?: string;
        };

        if (decodedError) {
          tx.errorName = decodedError.displayName;
          tx.errorReason = decodedError.fullText;
          tx.errorDataRaw = decodedError.rawData;
          tx.errorSelector = decodedError.selector;
          tx.decodedErrorSignature = decodedError.displayName;
          tx.errorDecodeStatus = decodedError.rawData.length > 10
            ? `Decoded from full revert data (${decodedError.source})`
            : `Matched by selector only (${decodedError.source})`;
          tx.errorProbeSource = error.__probeSource || 'unknown';
          tx.errorDebugRaw = safeStringifyError(callError);
          tx.sourceLocationMatches = findLikelySourceLocations(
            decodeSourceBundle,
            tx.functionName,
            decodedError.selector,
            decodedError.displayName,
            decodedError.fullText
          );
          tx.sourceLocationStatus = tx.sourceLocationMatches.length > 0
            ? 'Likely source match from function body + selector'
            : decodeSourceBundle
              ? 'Verified source found, but no likely source line match yet'
              : 'Verified source unavailable for source-line matching';
          tx.traceStatus = (error.__probeSource || '').includes('debug_traceTransaction')
            ? 'Decoded from failing trace frame'
            : 'Decoded without trace frame';
          tx.traceSummary = traceSummary;
          continue;
        }

        if (error.reason) {
          tx.errorReason = error.reason;
          tx.errorName = error.code || 'CALL_EXCEPTION';
          tx.errorSelector = errorSelector || undefined;
          if (errorData) tx.errorDataRaw = errorData;
          tx.errorDecodeStatus = errorData
            ? 'RPC returned hex but decode failed'
            : errorSelector
              ? 'RPC returned selector only'
              : 'RPC returned reason text only';
          tx.errorProbeSource = error.__probeSource || 'unknown';
          tx.errorDebugRaw = safeStringifyError(callError);
          tx.sourceLocationMatches = findLikelySourceLocations(
            decodeSourceBundle,
            tx.functionName,
            tx.errorSelector,
            tx.errorName,
            tx.errorReason
          );
          tx.sourceLocationStatus = tx.sourceLocationMatches.length > 0
            ? 'Likely source match from function body + selector'
            : decodeSourceBundle
              ? 'Verified source found, but no likely source line match yet'
              : 'Verified source unavailable for source-line matching';
          tx.traceStatus = traceSummary.length > 0 ? 'Trace checked' : 'Trace unavailable';
          tx.traceSummary = traceSummary;
          continue;
        }

        const fallbackMessage = error.shortMessage || error.message || 'Transaction failed - reason unknown';
        tx.errorReason = fallbackMessage;
        tx.errorName = error.code || 'UNKNOWN_ERROR';
        tx.errorSelector = errorSelector || undefined;
        if (errorData) tx.errorDataRaw = errorData;
        tx.errorDecodeStatus = errorData
          ? 'RPC returned hex but decode failed'
          : errorSelector
            ? 'RPC returned selector only'
            : 'RPC returned no revert hex';
        tx.errorProbeSource = error.__probeSource || 'unknown';
        tx.errorDebugRaw = safeStringifyError(callError);
        tx.sourceLocationMatches = findLikelySourceLocations(
          decodeSourceBundle,
          tx.functionName,
          tx.errorSelector,
          tx.errorName,
          tx.errorReason
        );
        tx.sourceLocationStatus = tx.sourceLocationMatches.length > 0
          ? 'Likely source match from function body + selector'
          : decodeSourceBundle
            ? 'Verified source found, but no likely source line match yet'
            : 'Verified source unavailable for source-line matching';
        tx.traceStatus = traceSummary.length > 0 ? 'Trace checked' : 'Trace unavailable';
        tx.traceSummary = traceSummary;
      }

      if (i > 0 && i % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, APP_CONFIG.RPC_DELAY_MS));
      }
    }
  };

  const fetchTransactions = async (fetchType: boolean | 'latest') => {
    if (!configValid || !config || !currentChainConfig || !currentContractConfig) {
      setError('Select a configured chain and a tracked contract first.');
      return;
    }

    setLoading(true);
    setError(null);

    const isInitialFetch = fetchType === true;
    const isLatestUpdate = fetchType === 'latest';

    setCurrentProgress(
      isInitialFetch
        ? 'Starting to fetch recent failed transactions...'
        : isLatestUpdate
          ? 'Checking for new failed transactions...'
          : 'Fetching more historical transactions...'
    );

    try {
      let allFailedTxs: Transaction[] = isInitialFetch ? [] : [...failedTransactions];
      let startPage = isInitialFetch ? 1 : pagesFetched + 1;
      let maxPages = isInitialFetch
        ? APP_CONFIG.INITIAL_PAGES_TO_FETCH
        : pagesFetched + APP_CONFIG.ADDITIONAL_PAGES_TO_FETCH;
      let page = startPage;
      let hasMore = true;
      let newTransactionsFound = 0;

      if (isLatestUpdate) {
        startPage = 1;
        maxPages = 5;
        page = 1;
      }

      while (hasMore && page <= maxPages) {
        setCurrentProgress(
          isLatestUpdate
            ? `Checking page ${page}/${maxPages} for new failures... (${newTransactionsFound} new)`
            : `Fetching page ${page}/${maxPages}... (${allFailedTxs.length} failures so far)`
        );

        const startBlock = currentContractConfig.deploymentBlock || 0;
        let pageSize: number = APP_CONFIG.API_PAGE_SIZE;
        if (page * pageSize > APP_CONFIG.API_MAX_WINDOW) {
          pageSize = Math.floor(APP_CONFIG.API_MAX_WINDOW / page);
          if (pageSize < 1) break;
        }

        const url =
          `${ETHERSCAN_API_V2_URL}?chainid=${currentChainConfig.chainId}` +
          `&module=account&action=txlist&address=${currentContractConfig.address}` +
          `&startblock=${startBlock}&endblock=99999999&page=${page}&offset=${pageSize}` +
          `&sort=desc&apikey=${config.etherscanApiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== '1') {
          if (typeof data.result === 'string' && data.result.includes('No transactions found')) break;
          throw new Error(data.result || data.message || 'Explorer API error');
        }

        const transactions: EtherscanTransaction[] = Array.isArray(data.result) ? data.result : [];
        if (transactions.length === 0) break;

        const convertedTxs: Transaction[] = transactions
          .filter((tx) => tx.isError === '1' || tx.txreceipt_status === '0')
          .map((tx) => ({
            hash: tx.hash,
            blockNumber: parseInt(tx.blockNumber, 10),
            from: tx.from,
            to: tx.to,
            value: tx.value,
            gasUsed: tx.gasUsed,
            gasPrice: tx.gasPrice,
            timestamp: parseInt(tx.timeStamp, 10),
            isError: tx.isError,
            txreceipt_status: tx.txreceipt_status,
            input: tx.input,
            methodId: tx.methodId,
            functionName: tx.functionName || 'Unknown'
          }));

        if (isLatestUpdate) {
          const existingHashes = new Set(allFailedTxs.map((tx) => tx.hash));
          const newTxs = convertedTxs.filter((tx) => !existingHashes.has(tx.hash));
          if (newTxs.length === 0) break;
          allFailedTxs = [...newTxs, ...allFailedTxs];
          newTransactionsFound += newTxs.length;
        } else {
          allFailedTxs = [...allFailedTxs, ...convertedTxs];
        }

        if (isInitialFetch && allFailedTxs.length >= 5) {
          allFailedTxs = allFailedTxs.slice(0, 5);
          hasMore = false;
          break;
        }

        if (allFailedTxs.length >= APP_CONFIG.MAX_FAILED_TRANSACTIONS) {
          allFailedTxs = allFailedTxs.slice(0, APP_CONFIG.MAX_FAILED_TRANSACTIONS);
          break;
        }

        if (transactions.length < pageSize) {
          hasMore = false;
        } else {
          page += 1;
          await new Promise((resolve) => setTimeout(resolve, APP_CONFIG.API_DELAY_MS));
        }
      }

      const uniqueTransactions = Array.from(
        new Map(allFailedTxs.map((tx) => [tx.hash, tx])).values()
      ).sort((a, b) => b.timestamp - a.timestamp);

      setCurrentProgress('Analyzing failed transactions for detailed error reasons...');
      const transactionsToAnalyze = uniqueTransactions.filter((tx) => needsErrorAnalysis(tx));
      await analyzeFailedTransactions(
        currentChainConfig,
        currentContractConfig,
        transactionsToAnalyze.slice(0, APP_CONFIG.MAX_TRANSACTIONS_TO_ANALYZE)
      );

      const latestBlock = uniqueTransactions.length > 0
        ? Math.max(...uniqueTransactions.map((tx) => tx.blockNumber))
        : 0;
      const totalPagesFetched = isInitialFetch ? Math.max(1, page - 1) : Math.max(pagesFetched, page - 1);

      setFailedTransactions(uniqueTransactions);
      setLastUpdatedBlock(latestBlock);
      setPagesFetched(totalPagesFetched);
      saveCurrentContractData(
        currentChainConfig.id,
        currentContractConfig.id,
        uniqueTransactions,
        latestBlock,
        totalPagesFetched
      );

      setCurrentProgress(
        isLatestUpdate
          ? newTransactionsFound > 0
            ? `Found ${newTransactionsFound} new failed transactions.`
            : 'No new failed transactions found.'
          : `Loaded ${uniqueTransactions.length} failed transactions.`
      );
    } catch (err) {
      console.error('Error fetching transactions:', err);
      setError(`Failed to fetch transactions: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchFailedTransactions = async () => fetchTransactions(true);
  const fetchMoreTransactions = async () => fetchTransactions(false);
  const fetchLatestTransactions = async () => fetchTransactions('latest');

  const reanalyzeStoredTransactions = async () => {
    if (!currentChainConfig || !currentContractConfig || failedTransactions.length === 0) {
      setError('No stored transactions are available to re-analyze.');
      return;
    }

    setLoading(true);
    setError(null);
    setCurrentProgress('Re-analyzing stored failed transactions...');

    try {
      const nextTransactions = [...failedTransactions];
      const transactionsNeedingAnalysis = nextTransactions.filter((tx) => needsErrorAnalysis(tx));

      await analyzeFailedTransactions(
        currentChainConfig,
        currentContractConfig,
        transactionsNeedingAnalysis.slice(0, APP_CONFIG.MAX_TRANSACTIONS_TO_ANALYZE)
      );

      setFailedTransactions(nextTransactions);
      saveCurrentContractData(
        currentChainConfig.id,
        currentContractConfig.id,
        nextTransactions,
        lastUpdatedBlock,
        pagesFetched
      );
      setCurrentProgress(`Re-analyzed ${transactionsNeedingAnalysis.length} stored failed transactions.`);
    } catch (err) {
      console.error('Error re-analyzing transactions:', err);
      setError(`Failed to re-analyze transactions: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const clearCurrentContractData = () => {
    if (!currentChainConfig || !currentContractConfig) return;

    if (confirm(`Clear all saved data for ${currentContractConfig.name} on ${currentChainConfig.name}?`)) {
      deleteStoredContractData(currentChainConfig.id, currentContractConfig.id);
      loadCurrentContractData(currentChainConfig.id, currentContractConfig.id);
      if (configRef.current) loadStoredDataSummary(configRef.current);
      setCurrentProgress('Cleared saved data for the current contract.');
    }
  };

  const clearAllData = () => {
    if (!config || !confirm('Clear all saved transaction data for every tracked contract?')) return;

    getConfiguredChains(config).forEach((chain) => {
      getTrackedContractsForChain(config, chain.id).forEach((contract) => {
        deleteStoredContractData(chain.id, contract.id);
      });
    });

    setFailedTransactions([]);
    setLastUpdatedBlock(0);
    setPagesFetched(0);
    setStoredDataSummary({});
    setCurrentProgress('Cleared all saved data.');
    if (configRef.current) loadStoredDataSummary(configRef.current);
  };

  const addTrackedContract = () => {
    if (!currentChainConfig || !configRef.current) {
      setError('Configure and select a chain before adding a contract.');
      return;
    }

    if (!ethers.isAddress(newContractAddress)) {
      setError('Please enter a valid EVM contract address.');
      return;
    }

    const checksumAddress = ethers.getAddress(newContractAddress);
    const contractId = checksumAddress.toLowerCase();
    const existing = trackedContracts.find((contract) => contract.id === contractId);
    if (existing) {
      setSelectedContract(existing.id);
      setShowAddContractForm(false);
      setError('That contract is already being tracked on this chain.');
      return;
    }

    const contract: TrackedContractConfig = {
      id: contractId,
      name: newContractName.trim() || `Contract ${checksumAddress.slice(0, 8)}`,
      address: checksumAddress,
      deploymentBlock: Number(newContractDeploymentBlock || 0),
      abi: null,
      isCustom: true
    };

    applyConfigUpdate((prev) => updateContractInConfig(prev, currentChainConfig.id, contract));
    setSelectedContract(contract.id);
    setSelectedErrorFilter('all');
    setShowAddContractForm(false);
    setNewContractName('');
    setNewContractAddress('');
    setNewContractDeploymentBlock('');
    setCurrentProgress(`Tracking ${contract.name} on ${currentChainConfig.name}.`);
    setError(null);
  };

  const removeTrackedContract = () => {
    if (!currentChainConfig || !currentContractConfig?.isCustom) return;

    if (!confirm(`Stop tracking ${currentContractConfig.name} on ${currentChainConfig.name}?`)) return;

    deleteStoredContractData(currentChainConfig.id, currentContractConfig.id);
    applyConfigUpdate((prev) => removeContractFromConfig(prev, currentChainConfig.id, currentContractConfig.id));
    setSelectedErrorFilter('all');
  };

  const formatDate = (timestamp: number) => new Date(timestamp * 1000).toLocaleString();

  const truncateHash = (hash: string) => `${hash.slice(0, 7)}...${hash.slice(-8)}`;
  const truncateAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

  const formatEther = (weiValue: string) => {
    try {
      return Number.parseFloat(ethers.formatEther(weiValue)).toFixed(6);
    } catch {
      return '0';
    }
  };

  const extractFunctionName = (functionName: string) => {
    if (!functionName || functionName === 'Unknown' || functionName === 'N/A') return functionName;
    const match = functionName.match(/^([^(]+)/);
    return match ? match[1].trim() : functionName;
  };

  const availableErrors = currentContractConfig
    ? getContractErrors(currentContractConfig.address, currentContractConfig.abi)
    : [];

  const filteredTransactions = selectedErrorFilter === 'all'
    ? failedTransactions
    : failedTransactions.filter((tx) => tx.decodedErrorSignature === selectedErrorFilter);

  const transactionsPerPage = APP_CONFIG.TRANSACTIONS_PER_PAGE;
  const totalPages = Math.ceil(filteredTransactions.length / transactionsPerPage);
  const currentTransactions = filteredTransactions.slice(
    (currentPage - 1) * transactionsPerPage,
    currentPage * transactionsPerPage
  );

  const handleConfigSaved = (nextConfig: ConfigData) => {
    setConfig(nextConfig);
    setConfigValid(isConfigValid(nextConfig));
  };

  if (!isClient) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="container mx-auto px-4">
          <div className="rounded-lg bg-white p-6 shadow-lg">
            <div className="py-8 text-center">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
              <p className="mt-2 text-gray-600">Loading application...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="container mx-auto px-4">
        <div className="rounded-lg bg-white p-6 shadow-lg">
          <div className="mb-6 flex items-center justify-between">
            <h1 className="text-3xl font-bold text-gray-800">Swarm Smart Contract Error Monitor</h1>
            <button
              onClick={() => setIsConfigModalOpen(true)}
              className="rounded-full p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-800"
              title="Configuration Settings"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>

          {!configValid && (
            <div className="mb-6 rounded border border-yellow-200 bg-yellow-50 px-4 py-3 text-yellow-800">
              <strong>Configuration required:</strong> add your Etherscan API key and at least one chain RPC in settings.
            </div>
          )}

          <div className="mb-6 grid grid-cols-1 gap-4 rounded-lg bg-gray-50 p-4 md:grid-cols-3">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">Select Chain</label>
              <select
                value={selectedChain}
                onChange={(event) => {
                  setSelectedChain(event.target.value);
                  setSelectedErrorFilter('all');
                }}
                className="w-full rounded-md border border-gray-300 p-2 focus:border-blue-500 focus:ring-blue-500"
              >
                {configuredChains.map((chain) => (
                  <option key={chain.id} value={chain.id}>
                    {chain.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="block text-sm font-medium text-gray-700">Tracked Contract</label>
                <button
                  onClick={() => setShowAddContractForm((prev) => !prev)}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  + Add
                </button>
              </div>
              <select
                value={selectedContract}
                onChange={(event) => {
                  setSelectedContract(event.target.value);
                  setSelectedErrorFilter('all');
                }}
                className="w-full rounded-md border border-gray-300 p-2 focus:border-blue-500 focus:ring-blue-500"
                disabled={trackedContracts.length === 0}
              >
                {trackedContracts.length === 0 && <option value="">No tracked contracts</option>}
                {trackedContracts.map((contract) => (
                  <option key={contract.id} value={contract.id}>
                    {contract.name} ({truncateAddress(contract.address)})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">Filter by Error Type</label>
              <select
                value={selectedErrorFilter}
                onChange={(event) => {
                  setSelectedErrorFilter(event.target.value);
                  setCurrentPage(1);
                }}
                className="w-full rounded-md border border-gray-300 p-2 focus:border-blue-500 focus:ring-blue-500"
                disabled={availableErrors.length === 0}
              >
                <option value="all">All Errors ({failedTransactions.length})</option>
                {availableErrors
                  .map((signature) => ({
                    signature,
                    count: failedTransactions.filter((tx) => tx.decodedErrorSignature === signature).length
                  }))
                  .filter(({ count }) => count > 0)
                  .map(({ signature, count }) => (
                    <option key={signature} value={signature}>
                      {signature} ({count})
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {showAddContractForm && currentChainConfig && (
            <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
              <h3 className="mb-3 text-lg font-semibold text-gray-800">
                Track contract on {currentChainConfig.name}
              </h3>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
                  <input
                    type="text"
                    value={newContractName}
                    onChange={(event) => setNewContractName(event.target.value)}
                    placeholder="Optional friendly name"
                    className="w-full rounded-md border border-gray-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Address</label>
                  <input
                    type="text"
                    value={newContractAddress}
                    onChange={(event) => setNewContractAddress(event.target.value)}
                    placeholder="0x..."
                    className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Deployment Block</label>
                  <input
                    type="number"
                    value={newContractDeploymentBlock}
                    onChange={(event) => setNewContractDeploymentBlock(event.target.value)}
                    placeholder="Optional"
                    className="w-full rounded-md border border-gray-300 px-3 py-2"
                  />
                </div>
              </div>
              <p className="mt-2 text-sm text-gray-600">
                We will try to fetch the ABI from the chain explorer automatically so custom errors can decode cleanly.
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={addTrackedContract}
                  className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
                >
                  Track Contract
                </button>
                <button
                  onClick={() => setShowAddContractForm(false)}
                  className="rounded-md border border-gray-300 px-4 py-2 font-medium text-gray-700 hover:bg-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="mb-6">
            <p className="mb-2 text-gray-600">
              <strong>Current Selection:</strong>{' '}
              {currentChainConfig ? currentChainConfig.name : 'No chain selected'}
              {currentContractConfig ? ` - ${currentContractConfig.name}` : ''}
            </p>
            {currentContractConfig && currentChainConfig && (
              <>
                <p className="mb-2 text-gray-600">
                  <strong>Contract Address:</strong>{' '}
                  <a
                    href={`${currentChainConfig.explorerUrl}/address/${currentContractConfig.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all font-mono text-sm text-blue-600 hover:text-blue-800"
                  >
                    {currentContractConfig.address}
                  </a>
                </p>
                <p className="mb-4 text-gray-600">
                  <strong>Statistics:</strong>{' '}
                  Failed transactions: <span className="font-bold text-red-600">{failedTransactions.length.toLocaleString()}</span>
                  {selectedErrorFilter !== 'all' && (
                    <span> | Filtered: <span className="font-bold text-orange-600">{filteredTransactions.length.toLocaleString()}</span></span>
                  )}
                  {' '}| Last updated block: <span className="font-mono">{lastUpdatedBlock.toLocaleString()}</span>
                </p>
                {currentContractConfig.isCustom && (
                  <button
                    onClick={removeTrackedContract}
                    className="rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    Remove tracked contract
                  </button>
                )}
              </>
            )}
          </div>

          {Object.keys(storedDataSummary).length > 0 && (
            <div className="mb-6 rounded-lg bg-blue-50 p-4">
              <h3 className="mb-3 text-lg font-semibold text-gray-800">Stored Failed Transactions Summary</h3>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {configuredChains.map((chain) => {
                  const chainSummary = storedDataSummary[chain.id] || {};
                  const chainContracts = getTrackedContractsForChain(config, chain.id);

                  return (
                    <div key={chain.id} className="rounded border bg-white p-3">
                      <h4 className="mb-2 font-medium text-gray-700">{chain.name}</h4>
                      {chainContracts.length === 0 && (
                        <div className="text-sm text-gray-500">No tracked contracts yet.</div>
                      )}
                      {chainContracts.map((contract) => {
                        const contractSummary = chainSummary[contract.id];
                        return (
                          <div key={contract.id} className="mb-1 text-sm text-gray-600">
                            <strong>{contract.name}:</strong>{' '}
                            {contractSummary?.transactions.length || 0} failed transactions
                            {' '}({contractSummary?.pagesFetched || 0} pages)
                            {contractSummary?.lastUpdatedBlock
                              ? ` (Block: ${contractSummary.lastUpdatedBlock.toLocaleString()})`
                              : ''}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mb-4 flex flex-wrap gap-3">
            {failedTransactions.length === 0 ? (
              <button
                onClick={fetchFailedTransactions}
                disabled={loading || !configValid || !currentContractConfig}
                className="rounded bg-red-600 px-4 py-2 font-bold text-white transition-colors hover:bg-red-700 disabled:bg-red-300"
              >
                {loading ? 'Fetching...' : 'Fetch Failed Transactions'}
              </button>
            ) : (
              <>
                <button
                  onClick={fetchLatestTransactions}
                  disabled={loading || !configValid || !currentContractConfig}
                  className="rounded bg-blue-600 px-4 py-2 font-bold text-white transition-colors hover:bg-blue-700 disabled:bg-gray-300"
                >
                  {loading ? 'Checking...' : 'Update Latest'}
                </button>
                {pagesFetched > 0 && (
                  <button
                    onClick={fetchMoreTransactions}
                    disabled={loading || !configValid || !currentContractConfig}
                    className="rounded bg-green-600 px-4 py-2 font-bold text-white transition-colors hover:bg-green-700 disabled:bg-gray-300"
                  >
                    {loading ? 'Fetching...' : `Fetch More (Past) - ${APP_CONFIG.ADDITIONAL_PAGES_TO_FETCH} pages`}
                  </button>
                )}
                <button
                  onClick={reanalyzeStoredTransactions}
                  disabled={loading || !currentContractConfig}
                  className="rounded bg-purple-600 px-4 py-2 font-bold text-white transition-colors hover:bg-purple-700 disabled:bg-gray-300"
                >
                  {loading ? 'Re-analyzing...' : 'Re-analyze Errors'}
                </button>
              </>
            )}

            {failedTransactions.length > 0 && (
              <>
                <button
                  onClick={clearCurrentContractData}
                  disabled={loading || !currentContractConfig}
                  className="rounded bg-orange-600 px-4 py-2 font-bold text-white transition-colors hover:bg-orange-700 disabled:bg-orange-300"
                >
                  Clear Current Contract
                </button>
                <button
                  onClick={clearAllData}
                  disabled={loading}
                  className="rounded bg-gray-600 px-4 py-2 font-bold text-white transition-colors hover:bg-gray-700 disabled:bg-gray-300"
                >
                  Clear All Data
                </button>
              </>
            )}
          </div>

          {currentProgress && (
            <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-4 py-3 text-blue-800">
              <strong>Status:</strong> {currentProgress}
            </div>
          )}

          {error && (
            <div className="mb-4 rounded border border-red-400 bg-red-100 px-4 py-3 text-red-700">
              <strong>Error:</strong> {error}
            </div>
          )}

          {loading && (
            <div className="py-8 text-center">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-red-600" />
              <p className="mt-2 text-gray-600">Processing failed transactions...</p>
              <p className="mt-1 text-sm text-gray-500">This may take several minutes.</p>
            </div>
          )}

          {!loading && !currentContractConfig && (
            <div className="rounded-lg bg-gray-50 py-12 text-center">
              <h3 className="mb-2 text-lg font-medium text-gray-900">No Tracked Contract Selected</h3>
              <p className="text-gray-600">
                Add a contract for the selected chain to start scanning failed transactions and decoding errors.
              </p>
            </div>
          )}

          {!loading && currentContractConfig && failedTransactions.length === 0 && (
            <div className="rounded-lg bg-gray-50 py-12 text-center">
              <h3 className="mb-2 text-lg font-medium text-gray-900">No Failed Transactions Data</h3>
              <p className="text-gray-600">
                No failed transaction data has been loaded for {currentContractConfig.name} on {currentChainConfig?.name}.
              </p>
              <p className="mt-2 text-sm text-gray-500">
                Click <strong>Fetch Failed Transactions</strong> to load error data from the blockchain.
              </p>
            </div>
          )}

          {!loading && filteredTransactions.length > 0 && currentChainConfig && (
            <div>
              <h2 className="mb-4 text-xl font-semibold text-gray-800">
                Failed Transactions ({filteredTransactions.length} total)
              </h2>

              {totalPages > 1 && (
                <div className="mb-4 flex justify-center">
                  <nav className="flex gap-2">
                    <button
                      onClick={() => setCurrentPage((page) => page - 1)}
                      disabled={currentPage === 1}
                      className="rounded bg-gray-200 px-3 py-1 text-sm hover:bg-gray-300 disabled:bg-gray-100 disabled:text-gray-400"
                    >
                      Previous
                    </button>
                    {Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
                      const pageNum = Math.max(1, Math.min(totalPages - 4, currentPage - 2)) + index;
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setCurrentPage(pageNum)}
                          className={`rounded px-3 py-1 text-sm ${
                            currentPage === pageNum ? 'bg-red-600 text-white' : 'bg-gray-200 hover:bg-gray-300'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setCurrentPage((page) => page + 1)}
                      disabled={currentPage === totalPages}
                      className="rounded bg-gray-200 px-3 py-1 text-sm hover:bg-gray-300 disabled:bg-gray-100 disabled:text-gray-400"
                    >
                      Next
                    </button>
                  </nav>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="min-w-full border border-gray-200 bg-white text-sm">
                  <thead className="bg-red-50">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Transaction
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Block
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        From
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Value
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Date
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Full Error Data
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Function
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {currentTransactions.map((tx, index) => (
                      <tr key={tx.hash} className={index % 2 === 0 ? 'bg-white' : 'bg-red-25'}>
                        <td className="whitespace-nowrap px-3 py-4 font-mono text-sm text-gray-900">
                          <a
                            href={`${currentChainConfig.explorerUrl}/tx/${tx.hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800"
                            title={tx.hash}
                          >
                            {truncateHash(tx.hash)}
                          </a>
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                          {tx.blockNumber.toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 font-mono text-sm text-gray-900">
                          <a
                            href={`${currentChainConfig.explorerUrl}/address/${tx.from}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800"
                            title={tx.from}
                          >
                            {truncateAddress(tx.from)}
                          </a>
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                          {formatEther(tx.value)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                          {formatDate(tx.timestamp)}
                        </td>
                        <td className="max-w-xl px-3 py-4 text-sm text-red-700">
                          <div className="font-semibold text-red-800">
                            {tx.errorName || 'Unknown'}
                          </div>
                          <div className="mt-1 text-xs text-gray-700">
                            Status: {tx.errorDecodeStatus || 'Not analyzed yet'}
                          </div>
                          <div className="mt-1 text-xs text-gray-700">
                            Probe: {tx.errorProbeSource || 'unknown'}
                          </div>
                          <div className="mt-1 font-mono text-xs text-gray-600">
                            Selector: {tx.errorSelector || 'not returned'}
                          </div>
                          <div className="mt-1 font-mono text-xs text-gray-600">
                            Hex: {tx.errorDataRaw || 'not returned by RPC'}
                          </div>
                          <div className="mt-1 whitespace-pre-wrap break-words text-gray-800">
                            {tx.errorReason || 'Unknown error'}
                          </div>
                          <div className="mt-2 text-xs text-gray-700">
                            Source: {tx.sourceLocationStatus || 'Not checked yet'}
                          </div>
                          <div className="mt-1 text-xs text-gray-700">
                            Trace: {tx.traceStatus || 'Not checked yet'}
                          </div>
                          {tx.traceSummary && tx.traceSummary.length > 0 && (
                            <div className="mt-1 rounded bg-slate-50 p-2 text-xs text-gray-700">
                              {tx.traceSummary.map((item) => (
                                <div key={item} className="font-mono">
                                  {item}
                                </div>
                              ))}
                            </div>
                          )}
                          {tx.sourceLocationMatches && tx.sourceLocationMatches.length > 0 && (
                            <div className="mt-1 rounded bg-amber-50 p-2 text-xs text-gray-700">
                              {tx.sourceLocationMatches.map((match) => (
                                <div key={match} className="font-mono">
                                  {match}
                                </div>
                              ))}
                            </div>
                          )}
                          {tx.errorDebugRaw && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs text-gray-600">
                                Raw RPC error payload
                              </summary>
                              <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-600">
                                {tx.errorDebugRaw}
                              </pre>
                            </details>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                          {tx.functionName !== 'Unknown' ? extractFunctionName(tx.functionName) : (tx.methodId || 'N/A')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
        onConfigSaved={handleConfigSaved}
      />
    </div>
  );
}
