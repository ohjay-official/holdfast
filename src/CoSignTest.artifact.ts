export default {
  contractName: 'CoSignTest',
  constructorInputs: [
    { name: 'ownerPk', type: 'pubkey' },
    { name: 'homePk', type: 'pubkey' },
  ],
  abi: [
    {
      name: 'cosign',
      inputs: [
        { name: 'homeSig', type: 'sig' },
        { name: 'ownerSig', type: 'sig' },
      ],
    },
  ],
  bytecode: 'OP_ROT OP_ROT OP_CHECKSIGVERIFY OP_CHECKSIG',
  source: 'pragma cashscript ^0.14.0;\n\n// Pre-kickoff risk test, not the Holdfast vault.\n// One spend that needs two keys: the page signs with homePk before sending\n// the request, and the wallet adds ownerSig over WizardConnect. Holdfast\'s\n// home code and guardian keys co-sign with the wallet this way.\ncontract CoSignTest(pubkey ownerPk, pubkey homePk) {\n    function cosign(sig homeSig, sig ownerSig) {\n        require(checkSig(homeSig, homePk));\n        require(checkSig(ownerSig, ownerPk));\n    }\n}\n',
  fingerprint: '68e73b159cb8d735336bd9f76fd8c2cf586d56954a3dd81c289c9061e6225de6',
  debug: {
    bytecode: '7b7badac',
    sourceMap: '9:25:9:32;:34::40;:8::43:1;10::10:45',
    logs: [],
    requires: [
      { ip: 4, line: 9 },
      { ip: 6, line: 10 },
    ],
  },
  compiler: {
    name: 'cashc',
    version: '0.14.0',
    options: {
      enforceFunctionParameterTypes: true,
      enforceLocktimeGuard: true,
    },
  },
  updatedAt: '2026-11-11T19:10:31.238Z',
} as const;
