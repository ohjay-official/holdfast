// A stand-in for the wallet side of a WizardConnect sign request, used to prove
// the requests we send carry everything a wallet needs. It reads the request
// the way Paytaca and Cashonize do: transaction as hex, source outputs as hex
// strings and `<bigint: Xn>` amounts, contract info for contract inputs.

import {
  SigningSerializationFlag,
  binToHex,
  createVirtualMachineBch,
  decodeTransaction,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash256,
  hexToBin,
  secp256k1,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { toBigInt, toUint8Array } from '@wizardconnect/core';
import type { RelaySignRequest, RelaySourceOutput } from '../src/relay.js';

const HASH_TYPE =
  SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;
const SIG_PLACEHOLDER = '41' + '00'.repeat(65);

type Hydrated = Output & {
  outpointTransactionHash: Uint8Array;
  outpointIndex: number;
  sequenceNumber: number;
  unlockingBytecode: Uint8Array;
  contract?: { redeemScript: Uint8Array; abiFunction: { name: string }; artifact: { contractName?: string } };
};

function hydrate(so: RelaySourceOutput): Hydrated {
  return {
    outpointTransactionHash: toUint8Array(so.outpointTransactionHash),
    outpointIndex: so.outpointIndex,
    sequenceNumber: so.sequenceNumber,
    unlockingBytecode: toUint8Array(so.unlockingBytecode),
    valueSatoshis: toBigInt(so.valueSatoshis),
    lockingBytecode: toUint8Array(so.lockingBytecode),
    ...(so.token && {
      token: {
        category: toUint8Array(so.token.category),
        amount: toBigInt(so.token.amount),
        ...(so.token.nft && {
          nft: {
            capability: (so.token.nft.capability ?? 'none') as 'none' | 'mutable' | 'minting',
            commitment: so.token.nft.commitment ? toUint8Array(so.token.nft.commitment) : new Uint8Array(),
          },
        }),
      },
    }),
    ...(so.contract && {
      contract: {
        abiFunction: so.contract.abiFunction as { name: string },
        redeemScript: toUint8Array(so.contract.redeemScript),
        artifact: so.contract.artifact as { contractName?: string },
      },
    }),
  };
}

function sign(privateKey: Uint8Array, tx: TransactionCommon, sourceOutputs: Output[], index: number, covered: Uint8Array) {
  const preimage = generateSigningSerializationBCH(
    { inputIndex: index, sourceOutputs, transaction: tx },
    { coveredBytecode: covered, signingSerializationType: new Uint8Array([HASH_TYPE]) },
  );
  const sig = secp256k1.signMessageHashSchnorr(privateKey, hash256(preimage));
  if (typeof sig === 'string') throw new Error(sig);
  return Uint8Array.from([...sig, HASH_TYPE]);
}

/**
 * Sign a request the way a wallet would, after a JSON round trip over the relay.
 * Every input listed in inputPaths is signed with `privateKey`.
 */
export function walletSign(
  request: RelaySignRequest,
  inputPaths: [number, string, number][],
  privateKey: Uint8Array,
): { signedTransaction: string; sourceOutputs: Output[] } {
  const wire = JSON.parse(JSON.stringify(request)) as RelaySignRequest;
  if (typeof wire.transaction !== 'string') throw new Error('transaction must be hex');
  const decoded = decodeTransaction(hexToBin(wire.transaction));
  if (typeof decoded === 'string') throw new Error(`Failed to decode transaction: ${decoded}`);
  const sourceOutputs = wire.sourceOutputs.map(hydrate);
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);

  const inputs = decoded.inputs.map((i) => ({ ...i }));
  for (const [index] of inputPaths) {
    const so = sourceOutputs[index];
    if (!so) throw new Error(`No source output for input ${index}`);
    if (so.contract) {
      const lock = binToHex(so.lockingBytecode);
      const expected = lock.match(/^aa20([0-9a-f]{64})87$/)?.[1];
      if (!expected || binToHex(hash256(so.contract.redeemScript)) !== expected) {
        throw new Error('Redeem script does not match P2SH32 locking bytecode');
      }
      const unlocking = binToHex(so.unlockingBytecode);
      if (!unlocking.includes(SIG_PLACEHOLDER)) throw new Error(`Input ${index}: no signature placeholder`);
      const sig = sign(privateKey, decoded, sourceOutputs, index, so.contract.redeemScript);
      inputs[index].unlockingBytecode = hexToBin(unlocking.replace(SIG_PLACEHOLDER, '41' + binToHex(sig)));
    } else {
      const sig = sign(privateKey, decoded, sourceOutputs, index, so.lockingBytecode);
      inputs[index].unlockingBytecode = hexToBin(`41${binToHex(sig)}21${binToHex(publicKey)}`);
    }
  }
  const signed = { ...decoded, inputs };
  const outputs: Output[] = sourceOutputs.map(({ lockingBytecode, valueSatoshis, token }) => ({
    lockingBytecode,
    valueSatoshis,
    ...(token && { token }),
  }));
  return { signedTransaction: binToHex(encodeTransaction(signed)), sourceOutputs: outputs };
}

/** Full consensus check of a signed transaction against its source outputs. */
export function verifySigned(signedTransaction: string, sourceOutputs: Output[]): true | string {
  const transaction = decodeTransaction(hexToBin(signedTransaction));
  if (typeof transaction === 'string') return transaction;
  return createVirtualMachineBch().verify({ sourceOutputs, transaction });
}
