// Converts CashScript's WalletConnect transaction object into the wire format
// WizardConnect wallets read in a sign request (hdwalletv1 protocol).
//
// Wallets decode `transaction` with hexToBin, so it must be a hex string; an
// object there decodes to zero bytes. Source outputs follow the reference
// `sourceOutputToRelay` in @wizardconnect/core: bytes as hex, amounts as
// `<bigint: Xn>`. Contract inputs keep their abiFunction, redeemScript and
// artifact so the wallet can check the redeem script and fill the signature.

import { binToHex, encodeTransaction } from '@bitauth/libauth';
import type { WcSourceOutput, WcTransactionObject } from 'cashscript';

const big = (n: bigint) => `<bigint: ${n}n>`;

export interface RelaySourceOutput {
  outpointTransactionHash: string;
  outpointIndex: number;
  unlockingBytecode: string;
  sequenceNumber: number;
  valueSatoshis: string;
  lockingBytecode: string;
  token?: {
    category: string;
    amount: string;
    nft?: { capability?: string; commitment?: string };
  };
  contract?: {
    abiFunction: unknown;
    redeemScript: string;
    artifact: unknown;
  };
}

export interface RelaySignRequest {
  transaction: string;
  sourceOutputs: RelaySourceOutput[];
  broadcast?: boolean;
  userPrompt?: string;
}

export function sourceOutputToRelay(so: WcSourceOutput): RelaySourceOutput {
  const out: RelaySourceOutput = {
    outpointTransactionHash: binToHex(so.outpointTransactionHash),
    outpointIndex: so.outpointIndex,
    unlockingBytecode: binToHex(so.unlockingBytecode),
    sequenceNumber: so.sequenceNumber,
    valueSatoshis: big(so.valueSatoshis),
    lockingBytecode: binToHex(so.lockingBytecode),
  };
  if (so.token) {
    const { nft } = so.token;
    out.token = {
      category: binToHex(so.token.category),
      amount: big(so.token.amount),
      ...(nft && {
        nft: {
          ...(nft.capability !== undefined && { capability: nft.capability }),
          ...(nft.commitment !== undefined && { commitment: binToHex(nft.commitment) }),
        },
      }),
    };
  }
  if (so.contract) {
    out.contract = {
      abiFunction: so.contract.abiFunction,
      redeemScript: binToHex(so.contract.redeemScript),
      artifact: so.contract.artifact,
    };
  }
  return out;
}

export function toRelaySignRequest(wc: WcTransactionObject): RelaySignRequest {
  return {
    transaction: binToHex(encodeTransaction(wc.transaction)),
    sourceOutputs: wc.sourceOutputs.map(sourceOutputToRelay),
    ...(wc.broadcast !== undefined && { broadcast: wc.broadcast }),
    ...(wc.userPrompt !== undefined && { userPrompt: wc.userPrompt }),
  };
}
