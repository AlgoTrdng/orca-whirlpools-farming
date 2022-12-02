import { ConfirmedTransactionMeta, PublicKey, TokenBalance } from '@solana/web3.js'

import { SOL_MINT } from '../constants.js'

const assert = (condition: boolean, err: string) => {
	if (!condition) {
		throw Error(err)
	}
}

const findTokenBalance = (mint: PublicKey, postTokenBalances: TokenBalance[]) =>
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	postTokenBalances.find(({ mint: _mint }) => mint.toString() === _mint)!.uiTokenAmount.amount

type ParseTransactionParams = {
	meta: ConfirmedTransactionMeta
	inputMint: PublicKey
	outputMint: PublicKey
}

/* eslint-disable @typescript-eslint/no-non-null-assertion */
export const parsePostTransactionBalances = ({
	meta,
	inputMint,
	outputMint,
}: ParseTransactionParams) => {
	const { postBalances, postTokenBalances } = meta

	assert(!!postTokenBalances, 'PostTokenBalances are not defined')

	if (inputMint.equals(SOL_MINT)) {
		const inputPostAmountRaw = postBalances[0]
		return {
			input: inputPostAmountRaw,
			output: Number(findTokenBalance(outputMint, postTokenBalances!)),
		}
	}
	if (outputMint.equals(SOL_MINT)) {
		const outputPostAmountRaw = postBalances[0]
		return {
			input: Number(findTokenBalance(inputMint, postTokenBalances!)),
			output: outputPostAmountRaw,
		}
	}
}
