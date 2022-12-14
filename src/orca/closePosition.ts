import {
	CollectFeesParams,
	CollectRewardsQuote,
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
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { WHIRLPOOL_ADDRESS } from '../config.js'
import { SLIPPAGE_TOLERANCE } from '../constants.js'
import { connection, ctx, fetcher, tokenA, tokenB, wallet } from '../global.js'
import { sendAndConfirmTransaction, TransactionResponseStatus } from '../solana/sendTransaction.js'
import { buildCreateAndCloseATAccountsInstructions, TokenData } from '../utils/ATAccounts.js'
import { retryOnThrow } from '../utils/retryOnThrow.js'
import { addBlockHashAndSign } from '../utils/sendTxAndRetryOnFail.js'
import { getWhirlpoolData } from './pool.js'

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

type BuildCollectRewardsIxParams = {
	position: PositionData
	positionAddress: PublicKey
	positionATAddress: PublicKey
	whirlpoolData: WhirlpoolData
	rewardsData: CollectRewardsQuote
}

const buildCollectRewardsIx = async ({
	position,
	positionATAddress,
	positionAddress,
	whirlpoolData,
	rewardsData,
}: BuildCollectRewardsIxParams) => {
	const tokensData: TokenData[] = []
	const mainInstructions: TransactionInstruction[] = []

	whirlpoolData.rewardInfos.forEach(({ vault, mint }, i) => {
		const rewardAmount = rewardsData[i]?.toNumber() || 0
		if (!rewardAmount) {
			return
		}

		const ATAddress = getAssociatedTokenAddressSync(mint, wallet.publicKey)
		tokensData.push({ mint, ATAddress })

		const { instructions: collectRewardIxs } = WhirlpoolIx.collectRewardIx(ctx.program, {
			whirlpool: position.whirlpool,
			positionAuthority: wallet.publicKey,
			position: positionAddress,
			positionTokenAccount: positionATAddress,
			rewardOwnerAccount: tokensData[i].ATAddress,
			rewardVault: vault,
			rewardIndex: i,
		})
		mainInstructions.push(...collectRewardIxs)
	})

	const { setupInstructions, cleanupInstructions } =
		await buildCreateAndCloseATAccountsInstructions(tokensData)

	return {
		setupInstructions,
		mainInstructions,
		cleanupInstructions,
	}
}

type BuildDecreaseLiquidityIxParams = {
	whirlpoolData: WhirlpoolData
	position: PositionData
	refetch: boolean
	accounts: CollectFeesParams
	tickLowerArrayAddress: PublicKey
	tickUpperArrayAddress: PublicKey
}

const buildDecreaseLiquidityIx = async ({
	whirlpoolData: _whirlpoolData,
	position,
	refetch,
	accounts,
	tickLowerArrayAddress,
	tickUpperArrayAddress,
}: BuildDecreaseLiquidityIxParams) => {
	const whirlpoolData = refetch ? await getWhirlpoolData() : _whirlpoolData
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
	refetch: boolean
}

export const closePosition = async ({
	whirlpoolData: _whirlpoolData,
	positionAddress,
	refetch,
}: ClosePositionParams): Promise<void> => {
	const whirlpoolData = refetch ? await getWhirlpoolData() : _whirlpoolData
	const position = await retryOnThrow(() => fetcher.getPosition(positionAddress, true))

	if (!position) {
		throw Error(`Could not fetch position: ${positionAddress.toString()}`)
	}

	// Get upper and lower tick array addresses
	const { publicKey: tickLowerArrayAddress } = PDAUtil.getTickArrayFromTickIndex(
		position.tickLowerIndex,
		whirlpoolData.tickSpacing,
		WHIRLPOOL_ADDRESS,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)
	const { publicKey: tickUpperArrayAddress } = PDAUtil.getTickArrayFromTickIndex(
		position.tickUpperIndex,
		whirlpoolData.tickSpacing,
		WHIRLPOOL_ADDRESS,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)

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

	const { setupInstructions, cleanupInstructions } =
		await buildCreateAndCloseATAccountsInstructions([tokenA, tokenB])

	// Create collect fees ix
	const positionATAddress = getAssociatedTokenAddressSync(position.positionMint, wallet.publicKey)
	const collectFeesIxAccounts: CollectFeesParams = {
		whirlpool: position.whirlpool,
		positionAuthority: wallet.publicKey,
		position: positionAddress,
		positionTokenAccount: positionATAddress,
		tokenOwnerAccountA: tokenA.ATAddress,
		tokenOwnerAccountB: tokenB.ATAddress,
		tokenVaultA: whirlpoolData.tokenVaultA,
		tokenVaultB: whirlpoolData.tokenVaultB,
	}
	const { instructions: collectFeesIx } = WhirlpoolIx.collectFeesIx(
		ctx.program,
		collectFeesIxAccounts,
	)

	// Check and create if needed collect rewards ix
	const { tickLower, tickUpper } = await getTickData({
		upper: tickUpperArrayAddress,
		lower: tickLowerArrayAddress,
		tickUpperIndex: position.tickUpperIndex,
		tickLowerIndex: position.tickLowerIndex,
		tickSpacing: whirlpoolData.tickSpacing,
	})

	const rewardsData = collectRewardsQuote({
		whirlpool: whirlpoolData,
		position,
		tickLower,
		tickUpper,
	})

	const rewardsIxs = await buildCollectRewardsIx({
		position,
		positionAddress,
		positionATAddress,
		whirlpoolData,
		rewardsData,
	})

	// Withdraw all liquidity
	let decreaseLiquidityIx = await buildDecreaseLiquidityIx({
		accounts: collectFeesIxAccounts,
		refetch: false,
		whirlpoolData,
		position,
		tickLowerArrayAddress,
		tickUpperArrayAddress,
	})

	const { instructions: closePositionIx } = WhirlpoolIx.closePositionIx(ctx.program, {
		positionAuthority: wallet.publicKey,
		receiver: wallet.publicKey,
		positionTokenAccount: positionATAddress,
		position: positionAddress,
		positionMint: position.positionMint,
	})

	const buildTx = async () => {
		const tx = new Transaction()
		tx.add(
			...updateFeesAndRewardsIxs,
			...setupInstructions,
			...collectFeesIx,
			...rewardsIxs.setupInstructions,
			...rewardsIxs.mainInstructions,
			decreaseLiquidityIx,
			...closePositionIx,
			...rewardsIxs.cleanupInstructions,
			...cleanupInstructions,
		)
		return addBlockHashAndSign({ tx, version: 'legacy' })
	}

	let tx = await buildTx()

	while (true) {
		const res = await sendAndConfirmTransaction(tx)
		switch (res.status) {
			case TransactionResponseStatus.SUCCESS: {
				return
			}
			case TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED: {
				return closePosition({ positionAddress, whirlpoolData, refetch: true })
			}
			case TransactionResponseStatus.ERROR: {
				if (typeof res.error !== 'string' && 'InstructionError' in res.error) {
					if (res.error.InstructionError && res.error.InstructionError[1]?.Custom === 6018) {
						// Slippage exceeded
						decreaseLiquidityIx = await buildDecreaseLiquidityIx({
							accounts: collectFeesIxAccounts,
							refetch: true,
							whirlpoolData,
							tickLowerArrayAddress,
							tickUpperArrayAddress,
							position,
						})
						tx = await buildTx()
					}
				}
			}
		}
		await setTimeout(500)
	}
}
