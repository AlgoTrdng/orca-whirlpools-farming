import { ParsableWhirlpool, WhirlpoolData } from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'

import { connection } from '../global.js'
import { retryOnThrow } from '../utils/retryOnThrow.js'

export const getWhirlpoolData = async (whirlpoolAddress: PublicKey): Promise<WhirlpoolData> => {
	const whirlpoolAccount = await retryOnThrow(() => connection.getAccountInfo(whirlpoolAddress))
	const whirlpoolAccountData = ParsableWhirlpool.parse(whirlpoolAccount?.data)
	if (!whirlpoolAccountData) {
		throw Error(`Whirlpool account does not exist: ${whirlpoolAddress.toString()}`)
	}
	return whirlpoolAccountData
}
