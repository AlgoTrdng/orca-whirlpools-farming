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
	mints: PublicKey[]
}

/* eslint-disable @typescript-eslint/no-non-null-assertion */
export const parsePostTransactionBalances = ({
	meta,
	mints,
}: ParseTransactionParams) => {
	const { postBalances, postTokenBalances } = meta

	assert(!!postTokenBalances, 'PostTokenBalances are not defined')

	const result = new Map<PublicKey, number>()
	for (const mint of mints) {
		result.set(
			mint,
			mint.equals(SOL_MINT) ? postBalances[0] : Number(findTokenBalance(mint, postTokenBalances!)),
		)
	}
	return result
}
