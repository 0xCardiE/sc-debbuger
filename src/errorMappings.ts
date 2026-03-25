import { ethers } from 'ethers';

export interface DecodedErrorResult {
  selector: string;
  displayName: string;
  fullText: string;
  rawData: string;
  source: 'standard' | 'preset' | 'abi' | 'unknown';
}

const commonErrors: string[] = [
  'OutOfGas()',
  'GasError()',
  'InsufficientFunds()',
  'UnknownError()',
  'StateDependentFailure()',
  'ExecutionFailed()'
];

const redistributionErrors = [
  'AlreadyClaimed()',
  'AlreadyCommitted()',
  'AlreadyRevealed()',
  'BatchDoesNotExist(bytes32)',
  'BucketDiffers(bytes32)',
  'CommitRoundNotStarted()',
  'CommitRoundOver()',
  'FirstRevealDone()',
  'InclusionProofFailed(uint8,bytes32)',
  'IndexOutsideSet(bytes32)',
  'InvalidSignatureLength()',
  'LastElementCheckFailed()',
  'MustStake2Rounds()',
  'NoCommitsReceived()',
  'NoMatchingCommit()',
  'NoReveals()',
  'NotAdmin()',
  'NotClaimPhase()',
  'NotCommitPhase()',
  'NotMatchingOwner()',
  'NotRevealPhase()',
  'NotStaked()',
  'OnlyPauser()',
  'OutOfDepth()',
  'OutOfDepthClaim(uint8)',
  'OutOfDepthReveal(bytes32)',
  'PhaseLastBlock()',
  'RandomElementCheckFailed()',
  'ReserveCheckFailed(bytes32)',
  'SigRecoveryFailed(bytes32)',
  'SocCalcNotMatching(bytes32)',
  'SocVerificationFailed(bytes32)',
  'WrongPhase()'
];

const postageStampErrors = [
  'AdministratorOnly()',
  'BatchDoesNotExist()',
  'BatchExists()',
  'BatchExpired()',
  'BatchTooSmall()',
  'DepthNotIncreasing()',
  'InsufficienChunkCount()',
  'InsufficientBalance()',
  'InvalidDepth()',
  'NoBatchesExist()',
  'NotBatchOwner()',
  'OnlyPauser()',
  'OnlyRedistributor()',
  'PriceOracleOnly()',
  'TotalOutpaymentDecreased()',
  'TransferFailed()',
  'ValueCannotBeZero()',
  'ValueDoesNotExist()',
  'ValueKeyPairExists()',
  'ZeroAddress()',
  'ZeroBalance()'
];

const priceOracleErrors = [
  'CallerNotAdmin()',
  'CallerNotPriceUpdater()',
  'PriceAlreadyAdjusted()',
  'UnexpectedZero()'
];

const stakingErrors = [
  'BelowMinimumStake()',
  'DecreasedCommitment()',
  'Frozen()',
  'OnlyPauser()',
  'OnlyRedistributor()',
  'TransferFailed()',
  'Unauthorized()'
];

const createInterface = (signatures: string[]) =>
  new ethers.Interface(signatures.map((signature) => `error ${signature}`));

const presetInterfaces: Record<string, ethers.Interface> = {
  redistribution: createInterface(redistributionErrors),
  postagestamp: createInterface(postageStampErrors),
  priceoracle: createInterface(priceOracleErrors),
  staking: createInterface(stakingErrors)
};

const presetContractInterfaces: Record<string, ethers.Interface> = {
  '0x5b718e36f5ce2f2f7e25a397040436ce6af3e89e': presetInterfaces.redistribution,
  '0x5069cdfb3d9e56d23b1caee83ce6109a7e4fd62d': presetInterfaces.redistribution,
  '0xcdfdc3752caaa826fe62531e0000c40546ec56a6': presetInterfaces.postagestamp,
  '0x45a1502382541cd610cc9068e88727426b696293': presetInterfaces.postagestamp,
  '0x95dc18380e92c13e4f8a4e94c99fb1b97250174b': presetInterfaces.priceoracle,
  '0x47eef336e7fe5bed98499a4696bce8f28c1b0a8b': presetInterfaces.priceoracle,
  '0xeef13ef9ed9cdd169701eef3cd832df298dd1bb4': presetInterfaces.staking,
  '0xda2a16ee889e7f04980a8d597b48c8d51b9518f4': presetInterfaces.staking
};

const standardInterface = new ethers.Interface([
  'error Error(string)',
  'error Panic(uint256)'
]);

const getErrorSelector = (errorData: string): string | null => {
  if (!errorData || !errorData.startsWith('0x') || errorData.length < 10) return null;
  return errorData.slice(0, 10).toLowerCase();
};

const buildSelectorMap = (iface: ethers.Interface): Record<string, string> => {
  const entries = iface.fragments
    .filter((fragment): fragment is ethers.ErrorFragment => fragment.type === 'error')
    .map((fragment) => {
      const signature = fragment.format('sighash');
      return [ethers.id(signature).slice(0, 10).toLowerCase(), signature] as const;
    });

  return Object.fromEntries(entries);
};

const presetSelectorMaps: Record<string, Record<string, string>> = {
  redistribution: buildSelectorMap(presetInterfaces.redistribution),
  postagestamp: buildSelectorMap(presetInterfaces.postagestamp),
  priceoracle: buildSelectorMap(presetInterfaces.priceoracle),
  staking: buildSelectorMap(presetInterfaces.staking)
};

const presetContractSelectorMaps: Record<string, Record<string, string>> = {
  '0x5b718e36f5ce2f2f7e25a397040436ce6af3e89e': presetSelectorMaps.redistribution,
  '0x5069cdfb3d9e56d23b1caee83ce6109a7e4fd62d': presetSelectorMaps.redistribution,
  '0xcdfdc3752caaa826fe62531e0000c40546ec56a6': presetSelectorMaps.postagestamp,
  '0x45a1502382541cd610cc9068e88727426b696293': presetSelectorMaps.postagestamp,
  '0x95dc18380e92c13e4f8a4e94c99fb1b97250174b': presetSelectorMaps.priceoracle,
  '0x47eef336e7fe5bed98499a4696bce8f28c1b0a8b': presetSelectorMaps.priceoracle,
  '0xeef13ef9ed9cdd169701eef3cd832df298dd1bb4': presetSelectorMaps.staking,
  '0xda2a16ee889e7f04980a8d597b48c8d51b9518f4': presetSelectorMaps.staking
};

const standardSelectorMap = buildSelectorMap(standardInterface);

const formatValue = (value: unknown): string => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map((item) => formatValue(item)).join(', ')}]`;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const formatParsedError = (parsed: ethers.ErrorDescription): DecodedErrorResult => {
  const args = parsed.args ? Array.from(parsed.args).map((arg) => formatValue(arg)) : [];
  const displayName = parsed.fragment.format('sighash');
  const fullText = args.length > 0 ? `${parsed.name}(${args.join(', ')})` : `${parsed.name}()`;

  return {
    selector: ethers.id(displayName).slice(0, 10).toLowerCase(),
    displayName,
    fullText,
    rawData: '',
    source: 'unknown'
  };
};

const parseWithInterface = (
  iface: ethers.Interface,
  errorData: string
): Omit<DecodedErrorResult, 'rawData' | 'source'> | null => {
  try {
    const parsed = iface.parseError(errorData);
    if (!parsed) return null;
    return formatParsedError(parsed);
  } catch {
    return null;
  }
};

export const getContractErrors = (contractAddress: string, contractAbi?: string | null): string[] => {
  const preset = presetContractInterfaces[contractAddress.toLowerCase()];
  const presetErrors = preset ? preset.fragments.map((fragment) => fragment.format('sighash')) : [];

  if (!contractAbi) return [...presetErrors, ...commonErrors];

  try {
    const abiInterface = new ethers.Interface(JSON.parse(contractAbi));
    const abiErrors = abiInterface.fragments
      .filter((fragment) => fragment.type === 'error')
      .map((fragment) => fragment.format('sighash'));

    return [...new Set([...abiErrors, ...presetErrors, ...commonErrors])];
  } catch {
    return [...presetErrors, ...commonErrors];
  }
};

const getAbiSelectorMap = (contractAbi?: string | null): Record<string, string> => {
  if (!contractAbi) return {};

  try {
    return buildSelectorMap(new ethers.Interface(JSON.parse(contractAbi)));
  } catch {
    return {};
  }
};

export const matchErrorSelector = (
  selector: string,
  contractAddress: string,
  contractAbi?: string | null
): DecodedErrorResult | null => {
  const normalizedSelector = selector.toLowerCase();
  const normalizedAddress = contractAddress.toLowerCase();
  const presetSelectorMap = presetContractSelectorMaps[normalizedAddress] || {};
  const abiSelectorMap = getAbiSelectorMap(contractAbi);
  const matchedSignature =
    standardSelectorMap[normalizedSelector] ||
    presetSelectorMap[normalizedSelector] ||
    abiSelectorMap[normalizedSelector];

  if (!matchedSignature) return null;

  return {
    selector: normalizedSelector,
    displayName: matchedSignature,
    fullText: matchedSignature,
    rawData: normalizedSelector,
    source: standardSelectorMap[normalizedSelector]
      ? 'standard'
      : presetSelectorMap[normalizedSelector]
        ? 'preset'
        : 'abi'
  };
};

export const decodeError = (
  errorData: string,
  contractAddress: string,
  contractAbi?: string | null
): DecodedErrorResult | null => {
  if (!errorData || !errorData.startsWith('0x') || errorData.length < 10) return null;

  const normalizedAddress = contractAddress.toLowerCase();

  const standardDecoded = parseWithInterface(standardInterface, errorData);
  if (standardDecoded) {
    return {
      ...standardDecoded,
      selector: getErrorSelector(errorData) || standardDecoded.selector,
      rawData: errorData,
      source: 'standard'
    };
  }

  const presetInterface = presetContractInterfaces[normalizedAddress];
  if (presetInterface) {
    const presetDecoded = parseWithInterface(presetInterface, errorData);
    if (presetDecoded) {
      return {
        ...presetDecoded,
        selector: getErrorSelector(errorData) || presetDecoded.selector,
        rawData: errorData,
        source: 'preset'
      };
    }
  }

  if (contractAbi) {
    try {
      const abiInterface = new ethers.Interface(JSON.parse(contractAbi));
      const abiDecoded = parseWithInterface(abiInterface, errorData);
      if (abiDecoded) {
        return {
          ...abiDecoded,
          selector: getErrorSelector(errorData) || abiDecoded.selector,
          rawData: errorData,
          source: 'abi'
        };
      }
    } catch {
      // Ignore invalid ABI payloads and fall through to selector-only mode.
    }
  }

  return {
    selector: getErrorSelector(errorData) || '0x',
    displayName: errorData.slice(0, 10),
    fullText: errorData,
    rawData: errorData,
    source: 'unknown'
  };
};
