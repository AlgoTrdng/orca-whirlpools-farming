import {
	IncreaseLiquidityInput,
	IncreaseLiquidityQuote,
	increaseLiquidityQuoteByInputTokenWithParams,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	PDAUtil,
	PriceMath,
	TickUtil,
	WhirlpoolData,
	WhirlpoolIx,
} from '@orca-so/whirlpools-sdk'
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, AccountLayout, RawAccount } from '@solana/spl-token'
import { Layout } from '@solana/buffer-layout'
import Decimal from 'decimal.js'

import { SLIPPAGE_TOLERANCE, SOL_MINT, USDC_MINT } from '../constants.js'
import { connection, ctx, fetcher, tokenA, tokenACoingeckoId, tokenB, wallet } from '../global.js'
import { ExecuteJupiterSwapParams, executeJupiterSwap } from '../utils/jupiter.js'
import { retryOnThrow } from '../utils/retryOnThrow.js'
import { sendTxAndRetryOnFail } from '../utils/sendTxAndRetryOnFail.js'
import { parsePostTransactionBalances } from '../solana/parseTransaction.js'
import { USDC_POSITION_SIZE, WHIRLPOOL_ADDRESS } from '../config.js'
import { BN } from 'bn.js'
import {
	buildCreateAndCloseATAccountsInstructions,
	buildWrapSolInstruction,
} from '../utils/ATAccounts.js'
import { getCoingeckoPriceInUsd } from '../utils/getCoingeckoPrice.js'

const accountLayout: Layout<RawAccount> = AccountLayout

type GetBoundariesTicksParams = {
	upperBoundary: number
	lowerBoundary: number
	tokenAMint: PublicKey
	tokenBMint: PublicKey
	tickSpacing: number
}

const getBoundariesTickIndexes = ({
	upperBoundary,
	lowerBoundary,
	tickSpacing,
}: GetBoundariesTicksParams) => {
	const tickUpperIndex = TickUtil.getInitializableTickIndex(
		PriceMath.priceToTickIndex(new Decimal(upperBoundary), tokenA.decimals, tokenB.decimals),
		tickSpacing,
	)
	const tickLowerIndex = TickUtil.getInitializableTickIndex(
		PriceMath.priceToTickIndex(new Decimal(lowerBoundary), tokenA.decimals, tokenB.decimals),
		tickSpacing,
	)
	return {
		tickUpperIndex,
		tickLowerIndex,
	}
}

type InputLiquidity = {
	liqInput: IncreaseLiquidityQuote
	usdcTokenIndex: 1 | 2 | null
}

const calculateInputLiquidity = async ({
	tickLowerIndex,
	tickUpperIndex,
	whirlpoolData,
}: ReturnType<typeof getBoundariesTickIndexes> & {
	whirlpoolData: WhirlpoolData
}): Promise<InputLiquidity> => {
	const increaseLiqParams = {
		slippageTolerance: SLIPPAGE_TOLERANCE,
		tickLowerIndex,
		tickUpperIndex,
		...whirlpoolData,
	}

	const usdcPerTokenInputSize = USDC_POSITION_SIZE / 2
	// if whirlpool token is USDC, calc liquidity by that token,
	/** A = 1, B = 2, none = null */
	const usdcTokenIndex = tokenA.mint.equals(USDC_MINT)
		? 1
		: tokenB.mint.equals(USDC_MINT)
		? 2
		: null

	if (usdcTokenIndex === null) {
		// use tokenA
		const coingeckoTokenAPrice = await getCoingeckoPriceInUsd(tokenACoingeckoId)
		const tokenAInputUI = usdcPerTokenInputSize / coingeckoTokenAPrice
		return {
			liqInput: increaseLiquidityQuoteByInputTokenWithParams({
				inputTokenMint: tokenA.mint,
				inputTokenAmount: new BN(Math.floor(tokenAInputUI * 10 ** tokenA.decimals)),
				...increaseLiqParams,
			}),
			usdcTokenIndex: null,
		}
	}

	// if whirlpool token is USDC, calc liquidity by that token
	return {
		liqInput: increaseLiquidityQuoteByInputTokenWithParams({
			inputTokenMint: USDC_MINT,
			inputTokenAmount: new BN(Math.floor(usdcPerTokenInputSize * 10 ** 6)),
			...increaseLiqParams,
		}),
		usdcTokenIndex: usdcTokenIndex,
	}
}

export const getWhirlpoolATAccountsBalances = async (): Promise<Balances> => {
	const resolveATAddress = (mint: PublicKey) =>
		mint.equals(SOL_MINT) ? wallet.publicKey : getAssociatedTokenAddressSync(mint, wallet.publicKey)

	const swapTokensAddresses = [resolveATAddress(tokenA.mint), resolveATAddress(tokenB.mint)]
	const accountInfos = await retryOnThrow(() =>
		connection.getMultipleAccountsInfo(swapTokensAddresses),
	)

	const balances: number[] = []

	swapTokensAddresses.forEach((ATAddress, i) => {
		const currentAccountInfo = accountInfos[i]

		if (!currentAccountInfo) {
			balances[i] = 0
			return
		}

		if (ATAddress.equals(wallet.publicKey)) {
			// Subtract 0.07 SOL to always leave some SOL in wallet
			balances[i] = currentAccountInfo.lamports - 70_000_000
		} else {
			const { amount } = accountLayout.decode(currentAccountInfo.data)
			balances[i] = Number(amount)
		}
	})

	return {
		tokenA: balances[0],
		tokenB: balances[1],
	}
}

type Balances = {
	tokenA: number
	tokenB: number
}

const getRequiredSwapsParams = (
	currentBalances: Balances,
	inputLiquidity: InputLiquidity,
): ExecuteJupiterSwapParams[] | null => {
	const { tokenMaxA, tokenMaxB } = inputLiquidity.liqInput
	// Expect user to have USDC
	if (inputLiquidity.usdcTokenIndex) {
		// usdc as input, other token as output
		const swapParams = {
			swapMode: 'ExactOut',
			inputMint: USDC_MINT,
		} as ExecuteJupiterSwapParams
		if (inputLiquidity.usdcTokenIndex === 1) {
			// tokenA is USDC
			swapParams.amountRaw = tokenMaxB.toNumber() - currentBalances.tokenB
			swapParams.outputMint = tokenB.mint
		} else {
			// tokenB is USDC
			swapParams.amountRaw = tokenMaxA.toNumber() - currentBalances.tokenA
			swapParams.outputMint = tokenA.mint
		}

		if (swapParams.amountRaw <= 0) {
			return null
		}
		return [swapParams]
	}

	// Need to check both tokens and if needed swap USDC for token
	const tokenADiff = tokenMaxA.toNumber() - currentBalances.tokenA
	const tokenBDiff = tokenMaxB.toNumber() - currentBalances.tokenB

	const swapsParams: ExecuteJupiterSwapParams[] = []
	if (tokenADiff > 0) {
		// Missing tokenA amount
		// Need to swap B for tokenADiff amount
		swapsParams.push({
			swapMode: 'ExactOut',
			amountRaw: tokenADiff,
			inputMint: USDC_MINT,
			outputMint: tokenA.mint,
		})
	}
	if (tokenBDiff > 0) {
		// Missing tokenB amount
		// Need to swap A fot tokenBDiff amount
		swapsParams.push({
			swapMode: 'ExactOut',
			amountRaw: tokenBDiff,
			inputMint: USDC_MINT,
			outputMint: tokenB.mint,
		})
	}

	return swapsParams.length ? swapsParams : null
}

type BuildCreatePositionIxParams = {
	tickLowerIndex: number
	tickUpperIndex: number
}

const buildCreatePositionIx = ({ tickLowerIndex, tickUpperIndex }: BuildCreatePositionIxParams) => {
	const positionMintKeypair = new Keypair()
	const positionPDAddress = PDAUtil.getPosition(
		ORCA_WHIRLPOOL_PROGRAM_ID,
		positionMintKeypair.publicKey,
	)

	const positionATAddress = getAssociatedTokenAddressSync(
		positionMintKeypair.publicKey,
		wallet.publicKey,
	)

	const { instructions } = WhirlpoolIx.openPositionIx(ctx.program, {
		funder: wallet.publicKey,
		owner: wallet.publicKey,
		positionPda: positionPDAddress,
		positionMintAddress: positionMintKeypair.publicKey,
		positionTokenAccount: positionATAddress,
		whirlpool: WHIRLPOOL_ADDRESS,
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
	tickLowerIndex: number
	tickUpperIndex: number
	liquidityInput: IncreaseLiquidityInput
	positionPDAddress: PublicKey
	positionATAddress: PublicKey
}

const buildDepositLiquidityIx = async ({
	whirlpoolData,
	tickLowerIndex,
	tickUpperIndex,
	liquidityInput,
	positionPDAddress,
	positionATAddress,
}: BuildDepositLiquidityIxParams) => {
	const instructions: TransactionInstruction[] = []

	const tickArrayLower = PDAUtil.getTickArrayFromTickIndex(
		tickLowerIndex,
		whirlpoolData.tickSpacing,
		WHIRLPOOL_ADDRESS,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)
	const tickArrayUpper = PDAUtil.getTickArrayFromTickIndex(
		tickUpperIndex,
		whirlpoolData.tickSpacing,
		WHIRLPOOL_ADDRESS,
		ORCA_WHIRLPOOL_PROGRAM_ID,
	)

	const { instructions: depositLiquidityIxs } = WhirlpoolIx.increaseLiquidityIx(ctx.program, {
		liquidityAmount: liquidityInput.liquidityAmount,
		tokenMaxA: liquidityInput.tokenMaxA,
		tokenMaxB: liquidityInput.tokenMaxB,
		whirlpool: WHIRLPOOL_ADDRESS,
		positionAuthority: ctx.wallet.publicKey,
		position: positionPDAddress,
		positionTokenAccount: positionATAddress,
		tokenOwnerAccountA: tokenA.ATAddress,
		tokenOwnerAccountB: tokenB.ATAddress,
		tokenVaultA: whirlpoolData.tokenVaultA,
		tokenVaultB: whirlpoolData.tokenVaultB,
		tickArrayLower: tickArrayLower.publicKey,
		tickArrayUpper: tickArrayUpper.publicKey,
	})
	instructions.push(...depositLiquidityIxs)

	return instructions
}

type OpenPositionParams = {
	whirlpoolData: WhirlpoolData
	upperBoundaryPrice: number
	lowerBoundaryPrice: number
}

export const openPosition = async ({
	whirlpoolData,
	upperBoundaryPrice,
	lowerBoundaryPrice,
}: OpenPositionParams) => {
	// Check and create tickArrayAccount
	const startTick = TickUtil.getStartTickIndex(
		whirlpoolData.tickCurrentIndex,
		whirlpoolData.tickSpacing,
	)
	const tickArrayPda = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, WHIRLPOOL_ADDRESS, startTick)
	const tickArrayAccount = await retryOnThrow(() =>
		fetcher.getTickArray(tickArrayPda.publicKey, true),
	)

	if (!tickArrayAccount) {
		const tx = new Transaction()
		const ix = WhirlpoolIx.initTickArrayIx(ctx.program, {
			startTick,
			tickArrayPda,
			whirlpool: WHIRLPOOL_ADDRESS,
			funder: wallet.publicKey,
		})
		tx.add(...ix.instructions)

		console.log('Initializing tick array account')
		await sendTxAndRetryOnFail(tx)
	}

	// Calculate boundaries ticks
	const { tickUpperIndex, tickLowerIndex } = getBoundariesTickIndexes({
		upperBoundary: upperBoundaryPrice,
		lowerBoundary: lowerBoundaryPrice,
		tickSpacing: whirlpoolData.tickSpacing,
		tokenAMint: tokenA.mint,
		tokenBMint: tokenB.mint,
	})

	// Get deposit amounts
	const inputLiqData = await calculateInputLiquidity({
		tickLowerIndex,
		tickUpperIndex,
		whirlpoolData,
	})

	// Execute swaps to match balances with tokenEstA and tokenEstB with 0.08 SOL as a remainder
	const balances = await getWhirlpoolATAccountsBalances()

	const swapsParams = getRequiredSwapsParams(balances, inputLiqData)
	if (swapsParams) {
		for (const swapParams of swapsParams) {
			console.log(
				'Need to swap:\n' +
					` ${swapParams.inputMint.toString()} for ${swapParams.outputMint.toString()}\n` +
					` Amount: ${swapParams.amountRaw}, mode: ${swapParams.swapMode}`,
			)
			await executeJupiterSwap(swapParams)
		}
	}

	// Create position
	const tx = new Transaction()

	const {
		instruction: createPositionIx,
		signers: _signers,
		position,
	} = buildCreatePositionIx({
		tickLowerIndex,
		tickUpperIndex,
	})
	tx.add(createPositionIx)

	const { setupInstructions, cleanupInstructions } =
		await buildCreateAndCloseATAccountsInstructions([tokenA, tokenB])
	const wrapSolIxs = buildWrapSolInstruction(inputLiqData.liqInput)

	const depositLiquidityIxs = await buildDepositLiquidityIx({
		liquidityInput: inputLiqData.liqInput,
		positionATAddress: position.ATAddress,
		positionPDAddress: position.PDAddress,
		whirlpoolData,
		tickLowerIndex,
		tickUpperIndex,
	})
	tx.add(...setupInstructions, ...wrapSolIxs, ...depositLiquidityIxs, ...cleanupInstructions)

	console.log('Opening position and depositing liquidity')
	const meta = await sendTxAndRetryOnFail(tx, _signers)
	console.log('Successfully deposited liquidity')

	const postTxBalances = parsePostTransactionBalances({
		mints: [tokenA.mint, tokenB.mint],
		meta,
	})

	return {
		balances: postTxBalances,
		positionMint: position.mint,
	}
}
