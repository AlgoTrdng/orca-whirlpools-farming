import {
	increaseLiquidityQuoteByInputToken,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	PDAUtil,
	PriceMath,
	TickUtil,
	Whirlpool,
	WhirlpoolData,
	WhirlpoolIx,
} from '@orca-so/whirlpools-sdk'
import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, AccountLayout, RawAccount } from '@solana/spl-token'
import { Layout } from '@solana/buffer-layout'
import Decimal from 'decimal.js'

import { SLIPPAGE_TOLERANCE, SOL_MINT, SOL_USDC_WHIRLPOOL_ADDRESS } from '../constants.js'
import { connection, ctx, fetcher, provider } from '../global.js'
import { ExecuteJupiterSwapParams, executeJupiterSwap } from '../utils/jupiter.js'
import { retryOnThrow } from '../utils/retryOnThrow.js'
import { sendTxAndRetryOnFail } from '../utils/sendTxAndRetryOnFail.js'

const accountLayout: Layout<RawAccount> = AccountLayout

type GetBoundariesTicksParams = {
	upperBoundary: number
	lowerBoundary: number
	whirlpool: Whirlpool
	tickSpacing: number
}

const getBoundariesTicks = ({
	upperBoundary,
	lowerBoundary,
	whirlpool,
	tickSpacing,
}: GetBoundariesTicksParams) => {
	const [tokenADecimals, tokenBDecimals] = [
		whirlpool.getTokenAInfo().decimals,
		whirlpool.getTokenBInfo().decimals,
	]
	const tickUpperBoundary = TickUtil.getInitializableTickIndex(
		PriceMath.priceToTickIndex(new Decimal(upperBoundary), tokenADecimals, tokenBDecimals),
		tickSpacing,
	)
	const tickLowerBoundary = TickUtil.getInitializableTickIndex(
		PriceMath.priceToTickIndex(new Decimal(lowerBoundary), tokenADecimals, tokenBDecimals),
		tickSpacing,
	)
	return {
		tickUpperBoundary,
		tickLowerBoundary,
	}
}

type Balances = {
	tokenA: number
	tokenB: number
}

type Mints = {
	tokenA: PublicKey
	tokenB: PublicKey
}

const calculateSwapAmounts = (
	mints: Mints,
	requiredBalances: Balances,
	currentBalances: Balances,
): ExecuteJupiterSwapParams | null => {
	const tokenADiff = requiredBalances.tokenA - currentBalances.tokenA
	const tokenBDiff = requiredBalances.tokenB - currentBalances.tokenB

	if (tokenADiff > 0) {
		// Missing tokenA amount
		// Need to swap B for tokenADiff amount
		return {
			swapMode: 'ExactOut',
			amountRaw: tokenADiff,
			inputMint: mints.tokenB,
			outputMint: mints.tokenA,
		}
	}

	if (tokenBDiff > 0) {
		// Missing tokenB amount
		// Need to swap A fot tokenBDiff amount
		return {
			swapMode: 'ExactOut',
			amountRaw: tokenBDiff,
			inputMint: mints.tokenA,
			outputMint: mints.tokenB,
		}
	}

	return null
}

type OpenPositionParams = {
	whirlpool: Whirlpool
	whirlpoolData: WhirlpoolData
	upperBoundaryPrice: number
	lowerBoundaryPrice: number
}

export const openPosition = async ({
	whirlpool,
	whirlpoolData,
	upperBoundaryPrice,
	lowerBoundaryPrice,
}: OpenPositionParams) => {
	// Check and create tickArrayAccount
	const startTick = TickUtil.getStartTickIndex(
		whirlpoolData.tickCurrentIndex,
		whirlpoolData.tickSpacing,
	)
	const tickArrayPda = PDAUtil.getTickArray(
		ORCA_WHIRLPOOL_PROGRAM_ID,
		SOL_USDC_WHIRLPOOL_ADDRESS,
		startTick,
	)
	const tickArrayAccount = await retryOnThrow(() =>
		fetcher.getTickArray(tickArrayPda.publicKey, true),
	)

	if (!tickArrayAccount) {
		const tx = new Transaction()
		const ix = WhirlpoolIx.initTickArrayIx(ctx.program, {
			startTick,
			tickArrayPda,
			whirlpool: whirlpool.getAddress(),
			funder: provider.wallet.publicKey,
		})
		tx.add(...ix.instructions)

		console.log('Initializing tick array account')
		await sendTxAndRetryOnFail(tx)
	}

	// Calculate boundaries ticks
	const { tickUpperBoundary, tickLowerBoundary } = getBoundariesTicks({
		upperBoundary: upperBoundaryPrice,
		lowerBoundary: lowerBoundaryPrice,
		tickSpacing: whirlpoolData.tickSpacing,
		whirlpool,
	})

	// Get deposit amounts
	const increaseLiquidityInput = increaseLiquidityQuoteByInputToken(
		whirlpoolData.tokenMintB,
		new Decimal(1),
		tickLowerBoundary,
		tickUpperBoundary,
		SLIPPAGE_TOLERANCE,
		whirlpool,
	)

	// Execute swaps to match balances with tokenEstA and tokenEstB with 0.08 SOL as a remainder
	const tokenAMint = whirlpool.getTokenAInfo().mint
	const tokenBMint = whirlpool.getTokenBInfo().mint

	const balances: Balances = await (async () => {
		const swapTokensAddresses = [
			tokenAMint.equals(SOL_MINT)
				? ctx.wallet.publicKey
				: getAssociatedTokenAddressSync(whirlpool.getTokenAInfo().mint, ctx.wallet.publicKey),
			getAssociatedTokenAddressSync(whirlpool.getTokenBInfo().mint, ctx.wallet.publicKey),
		]
		const [tokenAATAccount, tokenBATAccount] = await retryOnThrow(() =>
			connection.getMultipleAccountsInfo(swapTokensAddresses),
		)

		if (!tokenAATAccount || !tokenBATAccount) {
			throw Error('Position tokens ATAccounts are not crated')
		}

		let tokenABalanceRaw = 0
		if (swapTokensAddresses[0].equals(ctx.wallet.publicKey)) {
			// Subtract 0.07 SOL to always leave some in wallet
			tokenABalanceRaw = tokenAATAccount.lamports - 70_000_000
		} else {
			const { amount } = accountLayout.decode(tokenAATAccount.data)
			tokenABalanceRaw = Number(amount)
		}

		const { amount: tokenBBalance } = accountLayout.decode(tokenBATAccount.data)
		return {
			tokenB: Number(tokenBBalance),
			tokenA: tokenABalanceRaw,
		}
	})()

	const { tokenEstA, tokenEstB } = increaseLiquidityInput
	const swapParams = calculateSwapAmounts(
		{ tokenA: tokenAMint, tokenB: tokenBMint },
		{ tokenA: tokenEstA.toNumber(), tokenB: tokenEstB.toNumber() },
		balances,
	)
	if (swapParams) {
		console.log(
			'Need to swap:\n' +
				` ${swapParams.inputMint.toString()} for ${swapParams.outputMint.toString()}\n` +
				` Amount: ${swapParams.amountRaw}, mode: ${swapParams.swapMode}`,
		)
		await executeJupiterSwap(swapParams)
	}

	// Deposit liquidity
	const { positionMint, tx: openPositionTxBuilder } = await retryOnThrow(() =>
		whirlpool.openPosition(
			tickLowerBoundary,
			tickUpperBoundary,
			increaseLiquidityInput,
			ctx.wallet.publicKey,
		),
	)
	const { transaction: openPositionTx, signers } = await retryOnThrow(() =>
		openPositionTxBuilder.build(),
	)

	console.log('Opening position and depositing liquidity')
	await sendTxAndRetryOnFail(openPositionTx, signers)
	console.log('Successfully deposited liquidity')

	return {
		positionMint,
	}
}
