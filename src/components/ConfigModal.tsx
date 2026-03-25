'use client';

import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { AppChainConfig, DEFAULT_CHAIN_CONFIGS } from '../constants';
import { ConfigData, buildDefaultConfig, loadConfig, saveConfig } from '../utils/config';

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigSaved: (config: ConfigData) => void;
}

const buildNewChain = (): AppChainConfig => ({
  id: `custom-${Date.now()}`,
  name: '',
  chainId: 0,
  explorerUrl: '',
  rpcUrl: '',
  isCustom: true
});

interface RpcCapabilityResult {
  status: 'idle' | 'checking' | 'ok' | 'limited' | 'error';
  basicCall?: boolean;
  historicalCall?: boolean;
  debugTraceCall?: boolean;
  details?: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export default function ConfigModal({ isOpen, onClose, onConfigSaved }: ConfigModalProps) {
  const [config, setConfig] = useState<ConfigData>(buildDefaultConfig());
  const [isSaving, setIsSaving] = useState(false);
  const [rpcCapabilities, setRpcCapabilities] = useState<Record<string, RpcCapabilityResult>>({});

  useEffect(() => {
    if (!isOpen) return;
    setConfig(loadConfig() || buildDefaultConfig());
  }, [isOpen]);

  const handleApiKeyChange = (value: string) => {
    setConfig((prev) => ({
      ...prev,
      etherscanApiKey: value
    }));
  };

  const handleChainChange = <K extends keyof AppChainConfig>(
    chainId: string,
    field: K,
    value: AppChainConfig[K]
  ) => {
    setConfig((prev) => ({
      ...prev,
      chains: prev.chains.map((chain) =>
        chain.id === chainId
          ? {
              ...chain,
              [field]: field === 'name' && typeof value === 'string' && chain.isCustom
                ? value
                : value
            }
          : chain
      )
    }));
  };

  const handleAddChain = () => {
    setConfig((prev) => ({
      ...prev,
      chains: [...prev.chains, buildNewChain()]
    }));
  };

  const handleRemoveChain = (chainId: string) => {
    setConfig((prev) => {
      const nextChains = prev.chains.filter((chain) => chain.id !== chainId);
      const nextTrackedContracts = { ...prev.trackedContracts };
      delete nextTrackedContracts[chainId];

      return {
        ...prev,
        chains: nextChains,
        trackedContracts: nextTrackedContracts
      };
    });
  };

  const handleReset = () => {
    setConfig(buildDefaultConfig());
    setRpcCapabilities({});
  };

  const checkRpcCapabilities = async (chain: AppChainConfig) => {
    if (!chain.rpcUrl.trim()) {
      setRpcCapabilities((prev) => ({
        ...prev,
        [chain.id]: {
          status: 'error',
          details: 'Enter an RPC URL first.'
        }
      }));
      return;
    }

    setRpcCapabilities((prev) => ({
      ...prev,
      [chain.id]: {
        status: 'checking'
      }
    }));

    try {
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
      let basicCall = false;
      let historicalCall = false;
      let debugTraceCall = false;

      try {
        const result = await provider.send('eth_call', [{ to: ZERO_ADDRESS, data: '0x' }, 'latest']);
        basicCall = typeof result === 'string';
      } catch {
        basicCall = false;
      }

      try {
        const result = await provider.send('eth_call', [{ to: ZERO_ADDRESS, data: '0x' }, '0x1']);
        historicalCall = typeof result === 'string';
      } catch {
        historicalCall = false;
      }

      try {
        await provider.send('debug_traceCall', [{ to: ZERO_ADDRESS, data: '0x' }, 'latest', {}]);
        debugTraceCall = true;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        debugTraceCall = !message.includes('method not found') && !message.includes('-32601');
      }

      const status =
        basicCall && historicalCall && debugTraceCall
          ? 'ok'
          : basicCall && historicalCall
            ? 'limited'
            : basicCall
              ? 'limited'
              : 'error';

      const details = !basicCall
        ? 'Basic eth_call failed. This RPC is not suitable.'
        : !historicalCall
          ? 'Latest eth_call works, but historical eth_call looks unavailable or limited.'
          : !debugTraceCall
            ? 'Historical replay works. Debug trace methods are not exposed.'
            : 'Historical replay and debug tracing both appear available.';

      setRpcCapabilities((prev) => ({
        ...prev,
        [chain.id]: {
          status,
          basicCall,
          historicalCall,
          debugTraceCall,
          details
        }
      }));
    } catch (error) {
      setRpcCapabilities((prev) => ({
        ...prev,
        [chain.id]: {
          status: 'error',
          details: error instanceof Error ? error.message : 'RPC capability check failed.'
        }
      }));
    }
  };

  const handleSave = async () => {
    setIsSaving(true);

    try {
      if (!config.etherscanApiKey.trim()) {
        alert('Please enter your Etherscan API key.');
        return;
      }

      const configuredChains = config.chains.filter((chain) => chain.rpcUrl.trim());
      if (configuredChains.length === 0) {
        alert('Please configure at least one chain RPC URL.');
        return;
      }

      const incompleteChain = configuredChains.find(
        (chain) => !chain.name.trim() || !chain.chainId || !chain.explorerUrl.trim()
      );

      if (incompleteChain) {
        alert('Each configured chain needs a name, chain ID, explorer URL, and RPC URL.');
        return;
      }

      saveConfig(config);
      onConfigSaved(config);
      onClose();
    } catch (error) {
      console.error('Error saving configuration:', error);
      alert('Error saving configuration');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="p-6">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-800">Configuration</h2>
            <button
              onClick={onClose}
              className="text-2xl font-bold text-gray-500 hover:text-gray-700"
            >
              ×
            </button>
          </div>

          <div className="space-y-8">
            <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
              <h3 className="mb-4 text-lg font-semibold text-gray-700">Etherscan API V2</h3>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                API Key
              </label>
              <input
                type="text"
                value={config.etherscanApiKey}
                onChange={(event) => handleApiKeyChange(event.target.value)}
                placeholder="Enter your Etherscan API key"
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                One API key works across Etherscan, Basescan, Arbiscan, and Gnosisscan through the V2 API.
              </p>
            </div>

            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <h3 className="mb-2 text-lg font-semibold text-gray-700">RPC Requirements For Good Error Debugging</h3>
              <p className="text-sm text-gray-700">
                Public RPCs often omit historical revert payloads, which is why you see `missing revert data`.
                Best results need an RPC that supports historical `eth_call`. For deeper debugging and future
                exact tracing, support for `debug_traceCall` or `debug_traceTransaction` is strongly preferred.
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 p-4">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-700">Chains</h3>
                  <p className="text-sm text-gray-500">
                    Any chain with an RPC URL here will appear in the main chain menu.
                  </p>
                </div>
                <button
                  onClick={handleAddChain}
                  className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  + Add chain
                </button>
              </div>

              <div className="space-y-4">
                {config.chains.map((chain) => {
                  const isDefault = DEFAULT_CHAIN_CONFIGS.some((defaultChain) => defaultChain.id === chain.id);

                  return (
                    <div key={chain.id} className="rounded-lg border border-gray-200 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold text-gray-800">
                            {chain.name || 'New Chain'}
                          </h4>
                          <p className="text-xs text-gray-500">
                            {isDefault ? 'Default chain preset' : 'Custom chain'}
                          </p>
                        </div>
                        {!isDefault && (
                          <button
                            onClick={() => handleRemoveChain(chain.id)}
                            className="text-sm font-medium text-red-600 hover:text-red-700"
                          >
                            Remove
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-sm font-medium text-gray-700">
                            Chain Name
                          </label>
                          <input
                            type="text"
                            value={chain.name}
                            onChange={(event) =>
                              handleChainChange(chain.id, 'name', event.target.value)
                            }
                            placeholder="Ethereum"
                            className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>

                        <div>
                          <label className="mb-1 block text-sm font-medium text-gray-700">
                            Chain ID
                          </label>
                          <input
                            type="number"
                            value={chain.chainId || ''}
                            onChange={(event) =>
                              handleChainChange(chain.id, 'chainId', Number(event.target.value))
                            }
                            placeholder="1"
                            className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>

                        <div className="md:col-span-2">
                          <label className="mb-1 block text-sm font-medium text-gray-700">
                            Explorer URL
                          </label>
                          <input
                            type="text"
                            value={chain.explorerUrl}
                            onChange={(event) =>
                              handleChainChange(chain.id, 'explorerUrl', event.target.value)
                            }
                            placeholder="https://etherscan.io"
                            className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>

                        <div className="md:col-span-2">
                          <label className="mb-1 block text-sm font-medium text-gray-700">
                            RPC URL
                          </label>
                          <input
                            type="text"
                            value={chain.rpcUrl}
                            onChange={(event) =>
                              handleChainChange(chain.id, 'rpcUrl', event.target.value)
                            }
                            placeholder="https://your-chain-rpc.example"
                            className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <p className="mt-1 text-xs text-gray-500">
                            Leave blank if you do not want this chain shown in the main menu right now.
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 rounded border border-gray-100 bg-gray-50 p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium text-gray-700">RPC capability check</div>
                          <button
                            onClick={() => checkRpcCapabilities(chain)}
                            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                          >
                            {rpcCapabilities[chain.id]?.status === 'checking' ? 'Checking...' : 'Check RPC'}
                          </button>
                        </div>
                        <p className="mt-2 text-xs text-gray-600">
                          We check whether this RPC appears to support latest `eth_call`, historical `eth_call`, and `debug_traceCall`.
                        </p>
                        {rpcCapabilities[chain.id] && (
                          <div className="mt-2 text-xs text-gray-700">
                            <div>Status: {rpcCapabilities[chain.id].status}</div>
                            <div>Basic eth_call: {rpcCapabilities[chain.id].basicCall ? 'yes' : 'no'}</div>
                            <div>Historical eth_call: {rpcCapabilities[chain.id].historicalCall ? 'yes' : 'no'}</div>
                            <div>debug_traceCall: {rpcCapabilities[chain.id].debugTraceCall ? 'yes' : 'no'}</div>
                            <div className="mt-1">{rpcCapabilities[chain.id].details}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-8 flex items-center justify-between border-t border-gray-200 pt-6">
            <button
              onClick={handleReset}
              className="font-medium text-gray-600 hover:text-gray-800"
            >
              Reset defaults
            </button>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="rounded-md border border-gray-300 px-4 py-2 font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="rounded-md bg-blue-600 px-6 py-2 font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
              >
                {isSaving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
