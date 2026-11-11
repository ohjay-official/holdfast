export default {
  contractName: 'SignTest',
  constructorInputs: [
    { name: 'ownerPk', type: 'pubkey' },
  ],
  abi: [
    {
      name: 'bump',
      inputs: [
        { name: 'ownerSig', type: 'sig' },
      ],
    },
    {
      name: 'bumpAfterAge',
      inputs: [
        { name: 'ownerSig', type: 'sig' },
      ],
    },
    {
      name: 'withdraw',
      inputs: [
        { name: 'ownerSig', type: 'sig' },
      ],
    },
  ],
  bytecode: 'OP_OVER OP_0 OP_NUMEQUAL OP_IF OP_ROT OP_SWAP OP_CHECKSIGVERIFY OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_TXOUTPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_0 OP_OUTPUTBYTECODE OP_0 OP_UTXOBYTECODE OP_EQUALVERIFY OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_UTXOTOKENCATEGORY OP_EQUALVERIFY OP_0 OP_UTXOTOKENCOMMITMENT OP_BIN2NUM OP_0 OP_OUTPUTTOKENCOMMITMENT OP_SWAP OP_1ADD OP_4 OP_NUM2BIN OP_EQUALVERIFY OP_0 OP_OUTPUTVALUE OP_0 OP_UTXOVALUE d007 OP_SUB OP_GREATERTHANOREQUAL OP_NIP OP_ELSE OP_OVER OP_1 OP_NUMEQUAL OP_IF OP_1 OP_CHECKSEQUENCEVERIFY OP_DROP OP_ROT OP_SWAP OP_CHECKSIGVERIFY OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_TXOUTPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_0 OP_OUTPUTBYTECODE OP_0 OP_UTXOBYTECODE OP_EQUALVERIFY OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_UTXOTOKENCATEGORY OP_EQUALVERIFY OP_0 OP_UTXOTOKENCOMMITMENT OP_BIN2NUM OP_0 OP_OUTPUTTOKENCOMMITMENT OP_SWAP OP_1ADD OP_4 OP_NUM2BIN OP_EQUALVERIFY OP_0 OP_OUTPUTVALUE OP_0 OP_UTXOVALUE d007 OP_SUB OP_GREATERTHANOREQUAL OP_NIP OP_ELSE OP_SWAP OP_2 OP_NUMEQUALVERIFY OP_CHECKSIG OP_ENDIF OP_ENDIF',
  source: 'pragma cashscript ^0.14.0;\n\n// Holdfast pre-kickoff risk test. This is NOT the Holdfast vault contract.\n// It checks three things on a real wallet before the hackathon starts:\n//   1. Paytaca can sign a contract input over WizardConnect (placeholder signature).\n//   2. A mutable NFT can carry state through a covenant spend.\n//   3. A relative timelock (this.age) spend works with the wallet\'s signing.\ncontract SignTest(pubkey ownerPk) {\n    // Spend the test vault back into itself and add one to the counter in its NFT.\n    function bump(sig ownerSig) {\n        require(checkSig(ownerSig, ownerPk));\n        require(tx.inputs.length == 1);\n        require(tx.outputs.length == 1);\n\n        // Same contract, same token category and capability.\n        require(tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode);\n        require(tx.outputs[0].tokenCategory == tx.inputs[0].tokenCategory);\n\n        // The counter is 4 bytes, little-endian, and goes up by exactly one.\n        int counter = int(tx.inputs[0].nftCommitment);\n        require(tx.outputs[0].nftCommitment == toPaddedBytes(counter + 1, 4));\n\n        // Fee cap: at most 2,000 sats can leave as fees.\n        require(tx.outputs[0].value >= tx.inputs[0].value - 2000);\n    }\n\n    // Same as bump, but only once the vault has been confirmed for at least one block.\n    function bumpAfterAge(sig ownerSig) {\n        require(this.age >= 1);\n        require(checkSig(ownerSig, ownerPk));\n        require(tx.inputs.length == 1);\n        require(tx.outputs.length == 1);\n        require(tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode);\n        require(tx.outputs[0].tokenCategory == tx.inputs[0].tokenCategory);\n        int counter = int(tx.inputs[0].nftCommitment);\n        require(tx.outputs[0].nftCommitment == toPaddedBytes(counter + 1, 4));\n        require(tx.outputs[0].value >= tx.inputs[0].value - 2000);\n    }\n\n    // End of the test: the owner takes the coins back.\n    function withdraw(sig ownerSig) {\n        require(checkSig(ownerSig, ownerPk));\n    }\n}\n',
  fingerprint: '4e42bfd4ac6e17061780322decf3bbea71d540b1f3500f81c0d835b3dce62387',
  debug: {
    bytecode: '78009c637b7cadc3519dc4519d00cd00c78800d100ce8800cf8100d27c8b54808800cc00c602d00794a2776778519c6351b2757b7cadc3519dc4519d00cd00c78800d100ce8800cf8100d27c8b54808800cc00c602d00794a277677c529dac6868',
    sourceMap: '10:4:25:5;;;;11:25:11:33;:35::42;:8::45:1;12:16:12:32:0;:36::37;:8::39:1;13:16:13:33:0;:37::38;:8::40:1;16:27:16:28:0;:16::45:1;:59::60:0;:49::77:1;:8::79;17:27:17:28:0;:16::43:1;:57::58:0;:47::73:1;:8::75;20:36:20:37:0;:26::52:1;:22::53;21:27:21:28:0;:16::43:1;:61::68:0;:::72:1;:74::75:0;:47::76:1;:8::78;24:27:24:28:0;:16::35:1;:49::50:0;:39::57:1;:60::64:0;:39:::1;:8::66;10:32:25:5;:4;28::38::0;;;;29:28:29:29;:8::31:1;;30:25:30:33:0;:35::42;:8::45:1;31:16:31:32:0;:36::37;:8::39:1;32:16:32:33:0;:37::38;:8::40:1;33:27:33:28:0;:16::45:1;:59::60:0;:49::77:1;:8::79;34:27:34:28:0;:16::43:1;:57::58:0;:47::73:1;:8::75;35:36:35:37:0;:26::52:1;:22::53;36:27:36:28:0;:16::43:1;:61::68:0;:::72:1;:74::75:0;:47::76:1;:8::78;37:27:37:28:0;:16::35:1;:49::50:0;:39::57:1;:60::64:0;:39:::1;:8::66;28:40:38:5;:4;41::43::0;;;42:8:42:45:1;8:0:44:1;',
    logs: [],
    requires: [
      { ip: 7, line: 11 },
      { ip: 10, line: 12 },
      { ip: 13, line: 13 },
      { ip: 18, line: 16 },
      { ip: 23, line: 17 },
      { ip: 33, line: 21 },
      { ip: 41, line: 24 },
      { ip: 48, line: 29 },
      { ip: 52, line: 30 },
      { ip: 55, line: 31 },
      { ip: 58, line: 32 },
      { ip: 63, line: 33 },
      { ip: 68, line: 34 },
      { ip: 78, line: 36 },
      { ip: 86, line: 37 },
      { ip: 92, line: 42 },
    ],
    sourceTags: '40:40:sc;85:85:sc',
  },
  compiler: {
    name: 'cashc',
    version: '0.14.0',
    options: {
      enforceFunctionParameterTypes: true,
      enforceLocktimeGuard: true,
    },
  },
  updatedAt: '2026-11-11T11:35:18.045Z',
} as const;
