import {
	CollectFeesParams,
	collectRewardsQuote,
	decreaseLiquidityQuoteByLiquidityWithParams,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	ParsableTickArray,
	PDAUtil,
	PositionData,
	TickArrayData,
	TickArrayUtil,
	WhirlpoolData,
	WhirlpoolIx,
} from '@orca-so/whirlpools-sdk'
import {
	createAssociatedTokenAccountInstruction,
	getAssociatedTokenAddressSync,
	createCloseAccountInstruction,
} from '@solana/spl-token'
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { SLIPPAGE_TOLERANCE, SOL_MINT, SOL_USDC_WHIRLPOOL_ADDRESS } from '../constants.js'
import { connection, ctx, fetcher, solATAddress, usdcATAddress } from '../global.js'
import { sendAndConfirmTransaction, TransactionResponseStatus } from '../solana/sendTransaction.js'
import { retryOnThrow } from '../utils/retryOnThrow.js'
import { addBlockHashAndSign } from '../utils/sendTxAndRetryOnFail.js'
import { getWhirlpoolData } from './getPool.js'

type GetTickDataParams = {
	upper: PublicKey
	lower: PublicKey
	tickLowerIndex: number
	tickUpperIndex: number
	tickSpacing: number
}

const getTickData = async ({
	upper,
	lower,
	tickLowerIndex,
	tickUpperIndex,
	tickSpacing,
}: GetTickDataParams) => {
	// [upper, lower]
	let tickArrays: TickArrayData[] = []
	if (upper.equals(lower)) {
		const tickArrayData = await retryOnThrow(() => fetcher.getTickArray(upper, true))
		if (!tickArrayData) {
			throw Error('Tick array does not exist')
		}
		tickArrays = [tickArrayData, tickArrayData]
	} else {
		const tickArraysAccounts = await retryOnThrow(() =>
			connection.getMultipleAccountsInfo([upper, lower]),
		)
		tickArraysAccounts.forEach((ai, i) => {
			const parsed = ParsableTickArray.parse(ai?.data)
			if (!parsed) {
				throw Error('Tick array does not exist')
			}
			tickArrays[i] = parsed
		})
	}

	return {
		tickUpper: TickArrayUtil.getTickFromArray(tickArrays[0], tickUpperIndex, tickSpacing),
		tickLower: TickArrayUtil.getTickFromArray(tickArrays[1], tickLowerIndex, tickSpacing),
	}
}

type BuildDecreaseLiquidityIxParams = {
	whirlpoolData: WhirlpoolData
	position: PositionData
	whirlpoolAddress: PublicKey
	refetch: boolean
	accounts: CollectFeesParams
	tickLowerArrayAddress: PublicKey
	tickUpperArrayAddress: PublicKey
}

const buildDecreaseLiquidityIx = async ({
	whirlpoolData: _whirlpoolData,
	position,
	whirlpoolAddress,
	refetch,
	accounts,
	tickLowerArrayAddress,
	tickUpperArrayAddress,
}: BuildDecreaseLiquidityIxParams) => {
	const whirlpoolData = refetch ? await getWhirlpoolData(whirlpoolAddress) : _whirlpoolData
	const decreaseLiquidityQuote = decreaseLiquidityQuoteByLiquidityWithParams({
		liquidity: position.liquidity,
		slippageTolerance: SLIPPAGE_TOLERANCE,
		sqrtPrice: whirlpoolData.sqrtPrice,
		tickCurrentIndex: whirlpoolData.tickCurrentIndex,
		tickLowerIndex: position.tickLowerIndex,
		tickUpperIndex: position.tickUpperIndex,
	})
	const { instructions: decreaseLiquidityIx } = WhirlpoolIx.decreaseLiquidityIx(ctx.program, {
		liquidityAmount: decreaseLiquidityQuote.liquidityAmount,
		tokenMinA: decreaseLiquidityQuote.tokenMinA,
		tokenMinB: decreaseLiquidityQuote.tokenMinB,
		tickArrayLower: tickLowerArrayAddress,
		tickArrayUpper: tickUpperArrayAddress,
		...accounts,
	})
	return decreaseLiquidityIx[0]
}

type ClosePositionParams = {
	positionAddress: PublicKey
	whirlpoolData: WhirlpoolData
	whirlpoolAddress: PublicKey
	refetch: boolean
}

export const closePosition = async ({
	whirlpoolData: _whirlpoolData,
	positionAddress,
	whirlpoolAddress,
	refetch,
}: ClosePositionParams): Promise<void> => {
	const whirlpoolData = refetch ? await getWhirlpoolData(whirlpoolAddress) : _whirlpoolData
	const position = await retryOnThrow(() => fetcher.getPosition(positionAddress, true))

	if (!position) {
		throw Error(`Could not fetch position: ${positionAddress.toString()}`)
	}

	// Get upper and lower tick array addresses
	const { publicKey: tickLowerArrayAddress } = PDAUtil.getTickArrayFromTickIndex(
		position.tickLowerIndex,
		whirlpoolData.tickSpacing,
		SOL_USDC_WHIRLPOOL_ADDRESS,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)
	const { publicKey: tickUpperArrayAddress } = PDAUtil.getTickArrayFromTickIndex(
		position.tickUpperIndex,
		whirlpoolData.tickSpacing,
		SOL_USDC_WHIRLPOOL_ADDRESS,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)

	const instructions: TransactionInstruction[] = []

	// Update on chain fees and rewards
	const { instructions: updateFeesAndRewardsIxs } = WhirlpoolIx.updateFeesAndRewardsIx(
		ctx.program,
		{
			whirlpool: position.whirlpool,
			position: positionAddress,
			tickArrayLower: tickLowerArrayAddress,
			tickArrayUpper: tickUpperArrayAddress,
		},
	)

	instructions[0] = updateFeesAndRewardsIxs[0]
	// TODO: Check if both accounts exist and create accounts depending on result
	instructions[1] = createAssociatedTokenAccountInstruction(
		ctx.wallet.publicKey,
		solATAddress,
		ctx.wallet.publicKey,
		SOL_MINT,
	)

	// Create collect fees ix
	const positionATAddress = getAssociatedTokenAddressSync(
		position.positionMint,
		ctx.wallet.publicKey,
	)
	const collectFeesIxAccounts: CollectFeesParams = {
		whirlpool: position.whirlpool,
		positionAuthority: ctx.wallet.publicKey,
		position: positionAddress,
		positionTokenAccount: positionATAddress,
		tokenOwnerAccountA: solATAddress,
		tokenOwnerAccountB: usdcATAddress,
		tokenVaultA: whirlpoolData.tokenVaultA,
		tokenVaultB: whirlpoolData.tokenVaultB,
	}
	const { instructions: collectFeesIx } = WhirlpoolIx.collectFeesIx(
		ctx.program,
		collectFeesIxAccounts,
	)
	instructions[2] = collectFeesIx[0]

	// Check and create if needed collect rewards ix
	const { tickLower, tickUpper } = await getTickData({
		upper: tickUpperArrayAddress,
		lower: tickLowerArrayAddress,
		tickUpperIndex: position.tickUpperIndex,
		tickLowerIndex: position.tickLowerIndex,
		tickSpacing: whirlpoolData.tickSpacing,
	})

	const rewardQuote = collectRewardsQuote({
		whirlpool: whirlpoolData,
		position,
		tickLower,
		tickUpper,
	})

	for (let i = 0; i < rewardQuote.length; i++) {
		const rewardAmount = rewardQuote[i]?.toNumber() || 0
		if (!rewardAmount) {
			continue
		}
		const rewardTokenMint = whirlpoolData.rewardInfos[i].mint
		if (!rewardTokenMint) {
			continue
		}
		const rewardTokenATAddress = getAssociatedTokenAddressSync(
			rewardTokenMint,
			ctx.wallet.publicKey,
		)
		// TODO: Create token account if it does not exist
		const { instructions: collectRewardIxs } = WhirlpoolIx.collectRewardIx(ctx.program, {
			whirlpool: position.whirlpool,
			positionAuthority: ctx.wallet.publicKey,
			position: positionAddress,
			positionTokenAccount: positionATAddress,
			rewardOwnerAccount: rewardTokenATAddress,
			rewardVault: whirlpoolData.rewardInfos[i].vault,
			rewardIndex: i,
		})
		instructions[3 + i] = collectRewardIxs[0]
	}

	// Withdraw all liquidity
	let decreaseLiquidityIx = await buildDecreaseLiquidityIx({
		accounts: collectFeesIxAccounts,
		refetch: false,
		whirlpoolData,
		position,
		whirlpoolAddress,
		tickLowerArrayAddress,
		tickUpperArrayAddress,
	})
	instructions[6] = decreaseLiquidityIx

	const { instructions: closePositionIx } = WhirlpoolIx.closePositionIx(ctx.program, {
		positionAuthority: ctx.wallet.publicKey,
		receiver: ctx.wallet.publicKey,
		positionTokenAccount: positionATAddress,
		position: positionAddress,
		positionMint: position.positionMint,
	})

	instructions[7] = closePositionIx[0]
	instructions[8] = createCloseAccountInstruction(
		solATAddress,
		ctx.wallet.publicKey,
		ctx.wallet.publicKey,
	)

	let tx = new Transaction()
	tx.add(...instructions.filter((ix) => !!ix))
	await addBlockHashAndSign(tx)

	while (true) {
		const res = await sendAndConfirmTransaction(tx)
		switch (res.status) {
			case TransactionResponseStatus.SUCCESS: {
				return
			}
			case TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED: {
				return closePosition({ positionAddress, whirlpoolAddress, whirlpoolData, refetch: true })
			}
			case TransactionResponseStatus.ERROR: {
				if (typeof res.error !== 'string' && 'InstructionError' in res.error) {
					if (res.error.InstructionError && res.error.InstructionError[1]?.Custom === 6018) {
						// Slippage exceeded
						decreaseLiquidityIx = await buildDecreaseLiquidityIx({
							accounts: collectFeesIxAccounts,
							refetch: true,
							whirlpoolAddress,
							whirlpoolData,
							tickLowerArrayAddress,
							tickUpperArrayAddress,
							position,
						})
						instructions[6] = decreaseLiquidityIx
						tx = new Transaction()
						tx.add(...instructions.filter((ix) => !!ix))
						await addBlockHashAndSign(tx)
					}
				}
			}
		}
		await setTimeout(500)
	}
}
