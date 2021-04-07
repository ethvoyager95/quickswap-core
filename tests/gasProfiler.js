const {
  etherUnsigned,
  etherMantissa,
} = require('./Utils/Ethereum');

const {
  makeSToken,
  fastForward,
  preApprove,
  preSupply,
  quickRedeem,
} = require('./Utils/Strike');

const fs = require('fs');
const util = require('util');
const diffStringsUnified = require('jest-diff');


async function preRedeem(
  sToken,
  redeemer,
  redeemTokens,
  redeemAmount,
  exchangeRate
) {
  await preSupply(sToken, redeemer, redeemTokens);
  await send(sToken.underlying, 'harnessSetBalance', [
    sToken._address,
    redeemAmount
  ]);
}

const sortOpcodes = (opcodesMap) => {
  return Object.values(opcodesMap)
    .map(elem => [elem.fee, elem.name])
    .sort((a, b) => b[0] - a[0]);
};

const getGasCostFile = name => {
  try {
    const jsonString = fs.readFileSync(name);
    return JSON.parse(jsonString);
  } catch (err) {
    console.log(err);
    return {};
  }
};

const recordGasCost = (totalFee, key, filename, opcodes = {}) => {
  let fileObj = getGasCostFile(filename);
  const newCost = {fee: totalFee, opcodes: opcodes};
  console.log(diffStringsUnified(fileObj[key], newCost));
  fileObj[key] = newCost;
  fs.writeFileSync(filename, JSON.stringify(fileObj, null, ' '), 'utf-8');
};

async function mint(sToken, minter, mintAmount, exchangeRate) {
  expect(await preApprove(sToken, minter, mintAmount, {})).toSucceed();
  return send(sToken, 'mint', [mintAmount], { from: minter });
}

/// GAS PROFILER: saves a digest of the gas prices of common SToken operations
/// transiently fails, not sure why

describe('SToken', () => {
  let root, minter, redeemer, accounts, sToken;
  const exchangeRate = 50e3;
  const preMintAmount = etherUnsigned(30e4);
  const mintAmount = etherUnsigned(10e4);
  const mintTokens = mintAmount.div(exchangeRate);
  const redeemTokens = etherUnsigned(10e3);
  const redeemAmount = redeemTokens.mul(exchangeRate);
  const filename = './gasCosts.json';

  beforeEach(async () => {
    [root, minter, redeemer, ...accounts] = saddle.accounts;
    sToken = await makeSToken({
      comptrollerOpts: { kind: 'bool' },
      interestRateModelOpts: { kind: 'white-paper'},
      exchangeRate
    });
  });

  it('first mint', async () => {
    await send(sToken, 'harnessSetAccrualBlockNumber', [40]);
    await send(sToken, 'harnessSetBlockNumber', [41]);

    const trxReceipt = await mint(sToken, minter, mintAmount, exchangeRate);
    recordGasCost(trxReceipt.gasUsed, 'first mint', filename);
  });

  it.only('second mint', async () => {
    await mint(sToken, minter, mintAmount, exchangeRate);

    await send(sToken, 'harnessSetAccrualBlockNumber', [40]);
    await send(sToken, 'harnessSetBlockNumber', [41]);

    const mint2Receipt = await mint(sToken, minter, mintAmount, exchangeRate);
    expect(Object.keys(mint2Receipt.events)).toEqual(['AccrueInterest', 'Transfer', 'Mint']);

    console.log(mint2Receipt.gasUsed);
    const opcodeCount = {};

    await saddle.trace(mint2Receipt, {
      execLog: log => {
        if (log.lastLog != undefined) {
          const key = `${log.op} @ ${log.gasCost}`;
          opcodeCount[key] = (opcodeCount[key] || 0) + 1;
        }
      }
    });

    recordGasCost(mint2Receipt.gasUsed, 'second mint', filename, opcodeCount);
  });

  it('second mint, no interest accrued', async () => {
    await mint(sToken, minter, mintAmount, exchangeRate);

    await send(sToken, 'harnessSetAccrualBlockNumber', [40]);
    await send(sToken, 'harnessSetBlockNumber', [40]);

    const mint2Receipt = await mint(sToken, minter, mintAmount, exchangeRate);
    expect(Object.keys(mint2Receipt.events)).toEqual(['Transfer', 'Mint']);
    recordGasCost(mint2Receipt.gasUsed, 'second mint, no interest accrued', filename);

    // console.log("NO ACCRUED");
    // const opcodeCount = {};
    // await saddle.trace(mint2Receipt, {
    //   execLog: log => {
    //     opcodeCount[log.op] = (opcodeCount[log.op] || 0) + 1;
    //   }
    // });
    // console.log(getOpcodeDigest(opcodeCount));
  });

  it('redeem', async () => {
    await preRedeem(sToken, redeemer, redeemTokens, redeemAmount, exchangeRate);
    const trxReceipt = await quickRedeem(sToken, redeemer, redeemTokens);
    recordGasCost(trxReceipt.gasUsed, 'redeem', filename);
  });

  it.skip('print mint opcode list', async () => {
    await preMint(sToken, minter, mintAmount, mintTokens, exchangeRate);
    const trxReceipt = await quickMint(sToken, minter, mintAmount);
    const opcodeCount = {};
    await saddle.trace(trxReceipt, {
      execLog: log => {
        opcodeCount[log.op] = (opcodeCount[log.op] || 0) + 1;
      }
    });
    console.log(getOpcodeDigest(opcodeCount));
  });
});
