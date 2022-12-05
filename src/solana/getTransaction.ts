import { VersionedTransactionResponse } from '@solana/web3.js'
import fetch from 'node-fetch'

import { RPC_URL } from '../config.js'

type RPCRequestResponse<T> = {
	result: T
}

export const getTransaction = async (txId: string) => {
	try {
		const res = (await (
			await fetch(RPC_URL, {
				method: 'POST',
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'getTransaction',
					params: [
						txId,
						{
							commitment: 'confirmed',
							maxSupportedTransactionVersion: 0,
						},
					],
				}),
				headers: {
					'content-type': 'application/json',
				},
			})
		).json()) as RPCRequestResponse<VersionedTransactionResponse>
		return res.result
	} catch (error) {
		return null
	}
}
