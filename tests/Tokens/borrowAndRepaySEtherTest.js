const {
  etherGasCost,
  etherUnsigned,
  etherMantissa
} = require('../Utils/Ethereum');

const {
  makeSToken,
  balanceOf,
  borrowSnapshot,
  totalBorrows,
  fastForward,
  setBalance,
  preApprove,
  pretendBorrow,
  setEtherBalance,
  getBalances,
  adjustBalances
} = require('../Utils/Strike');

const BigNumber = require('bignumber.js');

const borrowAmount = etherUnsigned(10e3);
const repayAmount = etherUnsigned(10e2);

async function preBorrow(sToken, borrower, borrowAmount) {
  await send(sToken.comptroller, 'setBorrowAllowed', [true]);
  await send(sToken.comptroller, 'setBorrowVerify', [true]);
  await send(sToken.interestRateModel, 'setFailBorrowRate', [false]);
  await send(sToken, 'harnessSetFailTransferToAddress', [borrower, false]);
  await send(sToken, 'harnessSetAccountBorrows', [borrower, 0, 0]);
  await send(sToken, 'harnessSetTotalBorrows', [0]);
  await setEtherBalance(sToken, borrowAmount);
}

async function borrowFresh(sToken, borrower, borrowAmount) {
  return send(sToken, 'harnessBorrowFresh', [borrower, borrowAmount], {from: borrower});
}

async function borrow(sToken, borrower, borrowAmount, opts = {}) {
  await send(sToken, 'harnessFastForward', [1]);
  return send(sToken, 'borrow', [borrowAmount], {from: borrower});
}

async function preRepay(sToken, benefactor, borrower, repayAmount) {
  // setup either benefactor OR borrower for success in repaying
  await send(sToken.comptroller, 'setRepayBorrowAllowed', [true]);
  await send(sToken.comptroller, 'setRepayBorrowVerify', [true]);
  await send(sToken.interestRateModel, 'setFailBorrowRate', [false]);
  await pretendBorrow(sToken, borrower, 1, 1, repayAmount);
}

async function repayBorrowFresh(sToken, payer, borrower, repayAmount) {
  return send(sToken, 'harnessRepayBorrowFresh', [payer, borrower, repayAmount], {from: payer, value: repayAmount});
}

async function repayBorrow(sToken, borrower, repayAmount) {
  await send(sToken, 'harnessFastForward', [1]);
  return send(sToken, 'repayBorrow', [], {from: borrower, value: repayAmount});
}

async function repayBorrowBehalf(sToken, payer, borrower, repayAmount) {
  await send(sToken, 'harnessFastForward', [1]);
  return send(sToken, 'repayBorrowBehalf', [borrower], {from: payer, value: repayAmount});
}

describe('SEther', function () {
  let sToken, root, borrower, benefactor, accounts;
  beforeEach(async () => {
    [root, borrower, benefactor, ...accounts] = saddle.accounts;
    sToken = await makeSToken({kind: 'sether', comptrollerOpts: {kind: 'bool'}});
  });

  describe('borrowFresh', () => {
    beforeEach(async () => await preBorrow(sToken, borrower, borrowAmount));

    it("fails if comptroller tells it to", async () => {
      await send(sToken.comptroller, 'setBorrowAllowed', [false]);
      expect(await borrowFresh(sToken, borrower, borrowAmount)).toHaveTrollReject('BORROW_COMPTROLLER_REJECTION');
    });

    it("proceeds if comptroller tells it to", async () => {
      await expect(await borrowFresh(sToken, borrower, borrowAmount)).toSucceed();
    });

    it("fails if market not fresh", async () => {
      await fastForward(sToken);
      expect(await borrowFresh(sToken, borrower, borrowAmount)).toHaveTokenFailure('MARKET_NOT_FRESH', 'BORROW_FRESHNESS_CHECK');
    });

    it("continues if fresh", async () => {
      await expect(await send(sToken, 'accrueInterest')).toSucceed();
      await expect(await borrowFresh(sToken, borrower, borrowAmount)).toSucceed();
    });

    it("fails if protocol has less than borrowAmount of underlying", async () => {
      expect(await borrowFresh(sToken, borrower, borrowAmount.add(1))).toHaveTokenFailure('TOKEN_INSUFFICIENT_CASH', 'BORROW_CASH_NOT_AVAILABLE');
    });

    it("fails if borrowBalanceStored fails (due to non-zero stored principal with zero account index)", async () => {
      await pretendBorrow(sToken, borrower, 0, 3e18, 5e18);
      expect(await borrowFresh(sToken, borrower, borrowAmount)).toHaveTokenFailure('MATH_ERROR', 'BORROW_ACCUMULATED_BALANCE_CALCULATION_FAILED');
    });

    it("fails if calculating account new total borrow balance overflows", async () => {
      await pretendBorrow(sToken, borrower, 1e-18, 1e-18, -1);
      expect(await borrowFresh(sToken, borrower, borrowAmount)).toHaveTokenFailure('MATH_ERROR', 'BORROW_NEW_ACCOUNT_BORROW_BALANCE_CALCULATION_FAILED');
    });

    it("fails if calculation of new total borrow balance overflows", async () => {
      await send(sToken, 'harnessSetTotalBorrows', [-1]);
      expect(await borrowFresh(sToken, borrower, borrowAmount)).toHaveTokenFailure('MATH_ERROR', 'BORROW_NEW_TOTAL_BALANCE_CALCULATION_FAILED');
    });

    it("reverts if transfer out fails", async () => {
      await send(sToken, 'harnessSetFailTransferToAddress', [borrower, true]);
      await expect(borrowFresh(sToken, borrower, borrowAmount)).rejects.toRevert("revert TOKEN_TRANSFER_OUT_FAILED");
    });

    it("reverts if borrowVerify fails", async() => {
      await send(sToken.comptroller, 'setBorrowVerify', [false]);
      await expect(borrowFresh(sToken, borrower, borrowAmount)).rejects.toRevert("revert borrowVerify rejected borrow");
    });

    it("transfers the underlying cash, tokens, and emits Borrow event", async () => {
      const beforeBalances = await getBalances([sToken], [borrower]);
      const beforeProtocolBorrows = await totalBorrows(sToken);
      const result = await borrowFresh(sToken, borrower, borrowAmount);
      const afterBalances = await getBalances([sToken], [borrower]);
      expect(result).toSucceed();
      console.log(afterBalances)
      expect(afterBalances).toEqual(await adjustBalances(beforeBalances, [
        [sToken, 'eth', -borrowAmount],
        [sToken, 'borrows', borrowAmount],
        [sToken, borrower, 'eth', borrowAmount.sub(await etherGasCost(result))],
        [sToken, borrower, 'borrows', borrowAmount]
      ]));
      expect(result).toHaveLog('Borrow', {
        borrower: borrower,
        borrowAmount: borrowAmount.toString(),
        accountBorrows: borrowAmount.toString(),
        totalBorrows: beforeProtocolBorrows.add(borrowAmount).toString()
      });
    });

    it("stores new borrow principal and interest index", async () => {
      const beforeProtocolBorrows = await totalBorrows(sToken);
      await pretendBorrow(sToken, borrower, 0, 3, 0);
      await borrowFresh(sToken, borrower, borrowAmount);
      const borrowSnap = await borrowSnapshot(sToken, borrower);
      expect(borrowSnap.principal).toEqualNumber(borrowAmount);
      expect(borrowSnap.interestIndex).toEqualNumber(etherMantissa(3));
      expect(await totalBorrows(sToken)).toEqualNumber(beforeProtocolBorrows.add(borrowAmount));
    });
  });

  describe('borrow', () => {
    beforeEach(async () => await preBorrow(sToken, borrower, borrowAmount));

    it("emits a borrow failure if interest accrual fails", async () => {
      await send(sToken.interestRateModel, 'setFailBorrowRate', [true]);
      await send(sToken, 'harnessFastForward', [1]);
      await expect(borrow(sToken, borrower, borrowAmount)).rejects.toRevert("revert INTEREST_RATE_MODEL_ERROR");
    });

    it("returns error from borrowFresh without emitting any extra logs", async () => {
      expect(await borrow(sToken, borrower, borrowAmount.add(1))).toHaveTokenFailure('TOKEN_INSUFFICIENT_CASH', 'BORROW_CASH_NOT_AVAILABLE');
    });

    it("returns success from borrowFresh and transfers the correct amount", async () => {
      const beforeBalances = await getBalances([sToken], [borrower]);
      await fastForward(sToken);
      const result = await borrow(sToken, borrower, borrowAmount);
      const afterBalances = await getBalances([sToken], [borrower]);
      expect(result).toSucceed();
      expect(afterBalances).toEqual(await adjustBalances(beforeBalances, [
        [sToken, 'eth', -borrowAmount],
        [sToken, 'borrows', borrowAmount],
        [sToken, borrower, 'eth', borrowAmount.sub(await etherGasCost(result))],
        [sToken, borrower, 'borrows', borrowAmount]
      ]));
    });
  });

  describe('repayBorrowFresh', () => {
    [true, false].forEach(async (benefactorPaying) => {
      let payer;
      const label = benefactorPaying ? "benefactor paying" : "borrower paying";
      describe(label, () => {
        beforeEach(async () => {
          payer = benefactorPaying ? benefactor : borrower;

          await preRepay(sToken, payer, borrower, repayAmount);
        });

        it("fails if repay is not allowed", async () => {
          await send(sToken.comptroller, 'setRepayBorrowAllowed', [false]);
          expect(await repayBorrowFresh(sToken, payer, borrower, repayAmount)).toHaveTrollReject('REPAY_BORROW_COMPTROLLER_REJECTION', 'MATH_ERROR');
        });

        it("fails if block number ≠ current block number", async () => {
          await fastForward(sToken);
          expect(await repayBorrowFresh(sToken, payer, borrower, repayAmount)).toHaveTokenFailure('MARKET_NOT_FRESH', 'REPAY_BORROW_FRESHNESS_CHECK');
        });

        it("returns an error if calculating account new account borrow balance fails", async () => {
          await pretendBorrow(sToken, borrower, 1, 1, 1);
          await expect(repayBorrowFresh(sToken, payer, borrower, repayAmount)).rejects.toRevert('revert REPAY_BORROW_NEW_ACCOUNT_BORROW_BALANCE_CALCULATION_FAILED');
        });

        it("returns an error if calculation of new total borrow balance fails", async () => {
          await send(sToken, 'harnessSetTotalBorrows', [1]);
          await expect(repayBorrowFresh(sToken, payer, borrower, repayAmount)).rejects.toRevert('revert REPAY_BORROW_NEW_TOTAL_BALANCE_CALCULATION_FAILED');
        });

        it("reverts if checkTransferIn fails", async () => {
          await expect(
            send(sToken, 'harnessRepayBorrowFresh', [payer, borrower, repayAmount], {from: root, value: repayAmount})
          ).rejects.toRevert("revert sender mismatch");
          await expect(
            send(sToken, 'harnessRepayBorrowFresh', [payer, borrower, repayAmount], {from: payer, value: 1})
          ).rejects.toRevert("revert value mismatch");
        });

        it("reverts if repayBorrowVerify fails", async() => {
          await send(sToken.comptroller, 'setRepayBorrowVerify', [false]);
          await expect(repayBorrowFresh(sToken, payer, borrower, repayAmount)).rejects.toRevert("revert repayBorrowVerify rejected repayBorrow");
        });

        it("transfers the underlying cash, and emits RepayBorrow event", async () => {
          const beforeBalances = await getBalances([sToken], [borrower]);
          const result = await repayBorrowFresh(sToken, payer, borrower, repayAmount);
          const afterBalances = await getBalances([sToken], [borrower]);
          expect(result).toSucceed();
          if (borrower == payer) {
            expect(afterBalances).toEqual(await adjustBalances(beforeBalances, [
              [sToken, 'eth', repayAmount],
              [sToken, 'borrows', -repayAmount],
              [sToken, borrower, 'borrows', -repayAmount],
              [sToken, borrower, 'eth', -repayAmount.add(await etherGasCost(result))]
            ]));
          } else {
            expect(afterBalances).toEqual(await adjustBalances(beforeBalances, [
              [sToken, 'eth', repayAmount],
              [sToken, 'borrows', -repayAmount],
              [sToken, borrower, 'borrows', -repayAmount],
            ]));
          }
          expect(result).toHaveLog('RepayBorrow', {
            payer: payer,
            borrower: borrower,
            repayAmount: repayAmount.toString(),
            accountBorrows: "0",
            totalBorrows: "0"
          });
        });

        it("stores new borrow principal and interest index", async () => {
          const beforeProtocolBorrows = await totalBorrows(sToken);
          const beforeAccountBorrowSnap = await borrowSnapshot(sToken, borrower);
          expect(await repayBorrowFresh(sToken, payer, borrower, repayAmount)).toSucceed();
          const afterAccountBorrows = await borrowSnapshot(sToken, borrower);
          expect(afterAccountBorrows.principal).toEqualNumber(beforeAccountBorrowSnap.principal.sub(repayAmount));
          expect(afterAccountBorrows.interestIndex).toEqualNumber(etherMantissa(1));
          expect(await totalBorrows(sToken)).toEqualNumber(beforeProtocolBorrows.sub(repayAmount));
        });
      });
    });
  });

  describe('repayBorrow', () => {
    beforeEach(async () => {
      await preRepay(sToken, borrower, borrower, repayAmount);
    });

    it("reverts if interest accrual fails", async () => {
      await send(sToken.interestRateModel, 'setFailBorrowRate', [true]);
      await expect(repayBorrow(sToken, borrower, repayAmount)).rejects.toRevert("revert INTEREST_RATE_MODEL_ERROR");
    });

    it("reverts when repay borrow fresh fails", async () => {
      await send(sToken.comptroller, 'setRepayBorrowAllowed', [false]);
      await expect(repayBorrow(sToken, borrower, repayAmount)).rejects.toRevertWithError('COMPTROLLER_REJECTION', "revert repayBorrow failed");
    });

    it("returns success from repayBorrowFresh and repays the right amount", async () => {
      await fastForward(sToken);
      const beforeAccountBorrowSnap = await borrowSnapshot(sToken, borrower);
      expect(await repayBorrow(sToken, borrower, repayAmount)).toSucceed();
      const afterAccountBorrowSnap = await borrowSnapshot(sToken, borrower);
      expect(afterAccountBorrowSnap.principal).toEqualNumber(beforeAccountBorrowSnap.principal.sub(repayAmount));
    });

    it("reverts if overpaying", async () => {
      const beforeAccountBorrowSnap = await borrowSnapshot(sToken, borrower);
      let tooMuch = new BigNumber(beforeAccountBorrowSnap.principal).plus(1);
      await expect(repayBorrow(sToken, borrower, tooMuch)).rejects.toRevert("revert REPAY_BORROW_NEW_ACCOUNT_BORROW_BALANCE_CALCULATION_FAILED");
      // await assert.toRevertWithError(repayBorrow(sToken, borrower, tooMuch), 'MATH_ERROR', "revert repayBorrow failed");
    });
  });

  describe('repayBorrowBehalf', () => {
    let payer;

    beforeEach(async () => {
      payer = benefactor;
      await preRepay(sToken, payer, borrower, repayAmount);
    });

    it("reverts if interest accrual fails", async () => {
      await send(sToken.interestRateModel, 'setFailBorrowRate', [true]);
      await expect(repayBorrowBehalf(sToken, payer, borrower, repayAmount)).rejects.toRevert("revert INTEREST_RATE_MODEL_ERROR");
    });

    it("reverts from within repay borrow fresh", async () => {
      await send(sToken.comptroller, 'setRepayBorrowAllowed', [false]);
      await expect(repayBorrowBehalf(sToken, payer, borrower, repayAmount)).rejects.toRevertWithError('COMPTROLLER_REJECTION', "revert repayBorrowBehalf failed");
    });

    it("returns success from repayBorrowFresh and repays the right amount", async () => {
      await fastForward(sToken);
      const beforeAccountBorrowSnap = await borrowSnapshot(sToken, borrower);
      expect(await repayBorrowBehalf(sToken, payer, borrower, repayAmount)).toSucceed();
      const afterAccountBorrowSnap = await borrowSnapshot(sToken, borrower);
      expect(afterAccountBorrowSnap.principal).toEqualNumber(beforeAccountBorrowSnap.principal.sub(repayAmount));
    });
  });
});
