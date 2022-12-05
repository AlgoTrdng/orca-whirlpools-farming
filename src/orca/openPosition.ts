import {
	IncreaseLiquidityInput,
	increaseLiquidityQuoteByInputTokenWithParams,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	PDAUtil,
	PriceMath,
	TickUtil,
	WhirlpoolData,
	WhirlpoolIx,
} from '@orca-so/whirlpools-sdk'
import {
	Keypair,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js'
import { getAssociatedTokenAddressSync, AccountLayout, RawAccount } from '@solana/spl-token'
import { Layout } from '@solana/buffer-layout'
import Decimal from 'decimal.js'

import {
	decimals,
	SLIPPAGE_TOLERANCE,
	SOL_MINT,
	SOL_USDC_WHIRLPOOL_ADDRESS,
	USDC_MINT,
} from '../constants.js'
import { connection, ctx, fetcher, provider } from '../global.js'
import { ExecuteJupiterSwapParams, executeJupiterSwap } from '../utils/jupiter.js'
import { retryOnThrow } from '../utils/retryOnThrow.js'
import { sendTxAndRetryOnFail } from '../utils/sendTxAndRetryOnFail.js'
import { parsePostTransactionBalances } from '../solana/parseTransaction.js'
import { POSITION_SIZE_UI } from '../config.js'
import { createAssociatedTokenAccountInstruction } from '@solana/spl-token'
import { createSyncNativeInstruction } from '@solana/spl-token'
import { createCloseAccountInstruction } from '@solana/spl-token'
import { BN } from 'bn.js'

const accountLayout: Layout<RawAccount> = AccountLayout

type GetBoundariesTicksParams = {
	upperBoundary: number
	lowerBoundary: number
	tokenAMint: PublicKey
	tokenBMint: PublicKey
	tickSpacing: number
}

const getBoundariesTicks = ({
	upperBoundary,
	lowerBoundary,
	tokenAMint,
	tokenBMint,
	tickSpacing,
}: GetBoundariesTicksParams) => {
	const tokenADecimals = decimals[tokenAMint.toString()]
	const tokenBDecimals = decimals[tokenBMint.toString()]
	const tickUpperIndex = TickUtil.getInitializableTickIndex(
		PriceMath.priceToTickIndex(new Decimal(upperBoundary), tokenADecimals, tokenBDecimals),
		tickSpacing,
	)
	const tickLowerIndex = TickUtil.getInitializableTickIndex(
		PriceMath.priceToTickIndex(new Decimal(lowerBoundary), tokenADecimals, tokenBDecimals),
		tickSpacing,
	)
	return {
		tickUpperIndex,
		tickLowerIndex,
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

type GetWhirlpoolATAccountsBalancesParams = {
	tokenAMint: PublicKey
	tokenBMint: PublicKey
}

export const getWhirlpoolATAccountsBalances = async ({
	tokenAMint,
	tokenBMint,
}: GetWhirlpoolATAccountsBalancesParams): Promise<Balances> => {
	const swapTokensAddresses = [
		tokenAMint.equals(SOL_MINT)
			? ctx.wallet.publicKey
			: getAssociatedTokenAddressSync(tokenAMint, ctx.wallet.publicKey),
		getAssociatedTokenAddressSync(tokenBMint, ctx.wallet.publicKey),
	]
	const [tokenAATAccount, tokenBATAccount] = await retryOnThrow(() =>
		connection.getMultipleAccountsInfo(swapTokensAddresses),
	)

	if (!tokenAATAccount || !tokenBATAccount) {
		throw Error('Position tokens ATAccounts are not created')
	}

	let tokenABalanceRaw = 0
	if (swapTokensAddresses[0].equals(ctx.wallet.publicKey)) {
		// Subtract 0.07 SOL to always leave some SOL in wallet
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
}

type BuildCreatePositionIxParams = {
	whirlpoolAddress: PublicKey
	tickLowerIndex: number
	tickUpperIndex: number
}

const buildCreatePositionIx = ({
	whirlpoolAddress,
	tickLowerIndex,
	tickUpperIndex,
}: BuildCreatePositionIxParams) => {
	const positionMintKeypair = new Keypair()
	const positionPDAddress = PDAUtil.getPosition(
		ORCA_WHIRLPOOL_PROGRAM_ID,
		positionMintKeypair.publicKey,
	)

	const positionATAddress = getAssociatedTokenAddressSync(
		positionMintKeypair.publicKey,
		ctx.wallet.publicKey,
	)

	const { instructions } = WhirlpoolIx.openPositionIx(ctx.program, {
		funder: ctx.wallet.publicKey,
		owner: ctx.wallet.publicKey,
		positionPda: positionPDAddress,
		positionMintAddress: positionMintKeypair.publicKey,
		positionTokenAccount: positionATAddress,
		whirlpool: whirlpoolAddress,
		tickLowerIndex,
		tickUpperIndex,
	})

	return {
		instruction: instructions[0],
		signers: [positionMintKeypair],
		position: {
			mint: positionMintKeypair.publicKey,
			PDAddress: positionPDAddress.publicKey,
			ATAddress: positionATAddress,
		},
	}
}

type BuildDepositLiquidityIxParams = {
	whirlpoolData: WhirlpoolData
	whirlpoolAddress: PublicKey
	tickLowerIndex: number
	tickUpperIndex: number
	liquidityInput: IncreaseLiquidityInput
	positionPDAddress: PublicKey
	positionATAddress: PublicKey
}

const buildDepositLiquidityIx = async ({
	whirlpoolAddress,
	whirlpoolData,
	tickLowerIndex,
	tickUpperIndex,
	liquidityInput,
	positionPDAddress,
	positionATAddress,
}: BuildDepositLiquidityIxParams) => {
	const instructions: TransactionInstruction[] = []
	const cleanupInstructions: TransactionInstruction[] = []

	const mints = [
		{
			mint: whirlpoolData.tokenMintA,
			ATAddress: getAssociatedTokenAddressSync(whirlpoolData.tokenMintA, ctx.wallet.publicKey),
		},
		{
			mint: whirlpoolData.tokenMintB,
			ATAddress: getAssociatedTokenAddressSync(whirlpoolData.tokenMintB, ctx.wallet.publicKey),
		},
	]

	// Create WSOL ATA if needed
	for (const { mint, ATAddress } of mints) {
		console.log(mint.toString())
		if (!mint.equals(SOL_MINT)) {
			continue
		}
		console.log('Fetching acc')
		const ATAccountInfo = await retryOnThrow(() => connection.getAccountInfo(ATAddress))
		if (!ATAccountInfo || !ATAccountInfo.data) {
			instructions.push(
				createAssociatedTokenAccountInstruction(
					ctx.wallet.publicKey,
					ATAddress,
					ctx.wallet.publicKey,
					mint,
				),
			)
			cleanupInstructions.push(
				createCloseAccountInstruction(ATAddress, ctx.wallet.publicKey, ctx.wallet.publicKey),
			)
		}
	}

	// Transfer SOL to WSOL ATA
	if (mints[0].mint.equals(SOL_MINT)) {
		instructions.push(
			SystemProgram.transfer({
				fromPubkey: ctx.wallet.publicKey,
				toPubkey: mints[0].ATAddress,
				lamports: liquidityInput.tokenMaxA.toNumber(),
			}),
			createSyncNativeInstruction(mints[0].ATAddress),
		)
	}

	const tickArrayLower = PDAUtil.getTickArrayFromTickIndex(
		tickLowerIndex,
		whirlpoolData.tickSpacing,
		whirlpoolAddress,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)
	const tickArrayUpper = PDAUtil.getTickArrayFromTickIndex(
		tickUpperIndex,
		whirlpoolData.tickSpacing,
		whirlpoolAddress,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)

	const { instructions: depositLiquidityIxs } = WhirlpoolIx.increaseLiquidityIx(ctx.program, {
		liquidityAmount: liquidityInput.liquidityAmount,
		tokenMaxA: liquidityInput.tokenMaxA,
		tokenMaxB: liquidityInput.tokenMaxB,
		whirlpool: whirlpoolAddress,
		positionAuthority: ctx.wallet.publicKey,
		position: positionPDAddress,
		positionTokenAccount: positionATAddress,
		tokenOwnerAccountA: mints[0].ATAddress,
		tokenOwnerAccountB: mints[1].ATAddress,
		tokenVaultA: whirlpoolData.tokenVaultA,
		tokenVaultB: whirlpoolData.tokenVaultB,
		tickArrayLower: tickArrayLower.publicKey,
		tickArrayUpper: tickArrayUpper.publicKey,
	})
	instructions.push(...depositLiquidityIxs)

	return {
		instructions,
		cleanupInstructions,
	}
}

type OpenPositionParams = {
	whirlpoolData: WhirlpoolData
	whirlpoolAddress: PublicKey
	upperBoundaryPrice: number
	lowerBoundaryPrice: number
}

export const openPosition = async ({
	whirlpoolData,
	whirlpoolAddress,
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
			whirlpool: whirlpoolAddress,
			funder: provider.wallet.publicKey,
		})
		tx.add(...ix.instructions)

		console.log('Initializing tick array account')
		await sendTxAndRetryOnFail(tx)
	}

	const tokenAMint = whirlpoolData.tokenMintA
	const tokenBMint = whirlpoolData.tokenMintB

	// Calculate boundaries ticks
	const { tickUpperIndex, tickLowerIndex } = getBoundariesTicks({
		upperBoundary: upperBoundaryPrice,
		lowerBoundary: lowerBoundaryPrice,
		tickSpacing: whirlpoolData.tickSpacing,
		tokenAMint,
		tokenBMint,
	})

	// Get deposit amounts
	const increaseLiquidityInput = increaseLiquidityQuoteByInputTokenWithParams({
		inputTokenMint: tokenBMint,
		inputTokenAmount: new BN(Math.floor((POSITION_SIZE_UI / 2) * 10 ** 6)),
		slippageTolerance: SLIPPAGE_TOLERANCE,
		tickLowerIndex,
		tickUpperIndex,
		...whirlpoolData,
	})

	// Execute swaps to match balances with tokenEstA and tokenEstB with 0.08 SOL as a remainder
	const balances = await getWhirlpoolATAccountsBalances({
		tokenAMint,
		tokenBMint,
	})

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

	// Create position
	const tx = new Transaction()

	const {
		instruction: createPositionIx,
		signers: _signers,
		position,
	} = buildCreatePositionIx({
		whirlpoolAddress,
		tickLowerIndex,
		tickUpperIndex,
	})
	tx.add(createPositionIx)

	// Deposit liquidity
	const { instructions: depositLiquidityIxs, cleanupInstructions } = await buildDepositLiquidityIx({
		liquidityInput: increaseLiquidityInput,
		positionATAddress: position.ATAddress,
		positionPDAddress: position.PDAddress,
		whirlpoolAddress,
		whirlpoolData,
		tickLowerIndex,
		tickUpperIndex,
	})
	tx.add(...depositLiquidityIxs, ...cleanupInstructions)

	console.log('Opening position and depositing liquidity')
	const meta = await sendTxAndRetryOnFail(tx, _signers)
	console.log('Successfully deposited liquidity')

	const postTxBalances = parsePostTransactionBalances({
		mints: [SOL_MINT, USDC_MINT],
		meta,
	})

	return {
		balances: postTxBalances,
		positionMint: position.mint,
	}
}
