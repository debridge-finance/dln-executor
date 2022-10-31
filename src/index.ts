import { ChainId, Evm, OrderData, OrderState, PMMClient, Solana } from "@debridge-finance/pmm-client";
import { AdapterContainer, GetProfit, PriceFeed, ProviderAdapter } from "./interfaces";
import { Connection, Keypair, Transaction, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { readEnv } from "./helpers";
import { helpers, WRAPPED_SOL_MINT } from "@debridge-finance/solana-utils";
import Web3 from "web3";
import { RabbitNextOrder } from "./rabbitmq.order.feed";
import BigNumber from "bignumber.js";

(BigInt.prototype as any).toJSON = function () {
	return this.toString();
};

class CalimerApi implements PriceFeed {
	async getUsdPrice(chainId: ChainId, tokenAddress: string): Promise<number> {
		console.log(`Getting price of token: ${tokenAddress}, chain: ${chainId}`);
		const multiplier = 1e4;
		const query = `https://claimerapi.debridge.io/TokenPrice/usd_price?chainId=${chainId}&tokenAddress=0x${tokenAddress}`;
		// @ts-expect-error
		const response = await fetch(query);
		if (response.status === 200) {
			return Number(await response.text());
		} else {
			const parsedJson = (await response.json()) as { message: string };
			throw new Error(parsedJson.message);
		}
	}
}

class ProfitChecker implements GetProfit {
	private feeMap: Record<string, bigint> = {
		"-1": 1234n,
	};

	async getProfit(dstChainId: ChainId, giveUsdAmount: bigint, takeUsdAmount: bigint): Promise<bigint> {
		const delta = giveUsdAmount - takeUsdAmount;
		if (Object.keys(this.feeMap).includes(dstChainId.toString())) {
			return delta - this.feeMap[dstChainId.toString()];
		}
		return delta;
	}
}

class SolanaProvider implements ProviderAdapter {
	public wallet: Parameters<typeof helpers.sendAll>["1"];

	constructor(public connection: Connection, wallet: Keypair) {
		this.wallet = {
			publicKey: wallet.publicKey,
			signAllTransactions: (txs: Transaction[]) => {
				txs.map((tx) => {
					tx.partialSign(wallet);
				});
				return Promise.resolve(txs);
			},
			signTransaction: (tx: Transaction) => {
				tx.sign(wallet);
				return Promise.resolve(tx);
			},
		};
	}


	public get address(): string {
		return helpers.bufferToHex(this.wallet.publicKey.toBuffer());
	}


	async sendTransaction(data: unknown) {
		const txid = await helpers.sendAll(
			this.connection,
			this.wallet,
			[new Transaction().add(data as Transaction | TransactionInstruction)],
			undefined,
			undefined,
			false,
			true,
		);
		console.log(`[Solana] Sent tx: ${txid}`);
		return txid;
	}
}

class EvmProvider implements ProviderAdapter {
	wallet: never;

	constructor(public connection: Web3) { }

	public get address(): string {
		return this.connection.eth.defaultAccount!;
	}

	async sendTransaction(data: unknown) {
		const tx = data as { data: string; to: string; value: number };
		const gasLimit = await this.connection.eth.estimateGas(tx);
		const gasPrice = await this.connection.eth.getGasPrice();
		const result = await this.connection.eth.sendTransaction({
			...tx,
			from: this.connection.eth.defaultAccount!,
			gasPrice,
			gas: gasLimit,
		});
		console.log(`[EVM] Sent tx: ${result.transactionHash}`);

		return result;
	}
}

const feed = new CalimerApi();
const checker = new ProfitChecker();

type EmptyTuple = [];
type Head<T extends unknown[]> = T extends [...infer U, unknown] ? U : unknown[];
type OmitLastParam<F> = F extends (...args: infer P) => infer Ret
	? Head<P> extends EmptyTuple
	? () => Ret
	: (...args: Head<P>) => Ret
	: never;

function wrapIntoAbortController<T extends (...args: any[]) => any>(fn: T, ...args: Parameters<OmitLastParam<T>>) {
	const controller = new AbortController();
	const { signal } = controller;
	fn(...args, signal);
	return controller;
}

async function orderProcessor(
	client: PMMClient,
	beneficiaryMap: Map<ChainId, string>,
	providers: AdapterContainer,
	order: OrderData,
	priceFeed: PriceFeed,
	profitChecker: GetProfit,
	expectedProfit: bigint,
	signal: AbortSignal,
): Promise<bigint | undefined> {
	if (signal.aborted) return undefined;

	const evmNative = "0x0000000000000000000000000000000000000000";
	const solanaNative = WRAPPED_SOL_MINT.toBase58();

	const [giveNativePrice, takeNativePrice, givePrice, takePrice] = await Promise.all([
		priceFeed.getUsdPrice(order.give.chainId, order.give.chainId != ChainId.Solana ? evmNative : solanaNative),
		priceFeed.getUsdPrice(order.take.chainId, order.take.chainId != ChainId.Solana ? evmNative : solanaNative),
		priceFeed.getUsdPrice(order.give.chainId, Buffer.from(order.give.tokenAddress).toString("hex")),
		priceFeed.getUsdPrice(order.take.chainId, Buffer.from(order.take.tokenAddress).toString("hex")),
	]);
	if (signal.aborted) return undefined;
	const giveWeb3 = order.give.chainId != ChainId.Solana ? providers[order.give.chainId].connection as Web3 : undefined;
	const takeWeb3 = order.take.chainId != ChainId.Solana ? providers[order.take.chainId].connection as Web3 : undefined;
	const fees = await client.getTakerFlowCost(order, giveNativePrice, takeNativePrice, { giveWeb3: (giveWeb3 || takeWeb3)!, takeWeb3: (takeWeb3 || giveWeb3)! });

	const giveUsdAmount = BigNumber(givePrice).multipliedBy(order.give.amount.toString());
	const takeUsdAmount = BigNumber(takePrice).multipliedBy(order.take.amount.toString());
	const profit = takeUsdAmount.minus(giveUsdAmount).minus(fees.total);
	if (profit.lt(expectedProfit.toString())) return undefined;
	if (signal.aborted) return undefined;

	console.log(`Profit is: ${profit}`);
	// if (profit < expectedProfit) return undefined;

	let fulfillIx;
	// taker = signer
	if (order.take.chainId === ChainId.Solana)
		fulfillIx = await client.fulfillOrder<ChainId.Solana>(order, {
			taker: (providers[order.take.chainId].wallet as { publicKey: PublicKey }).publicKey,
		});
	else
		fulfillIx = await client.fulfillOrder<ChainId.Ethereum>(order, {
			web3: providers[order.take.chainId].connection as Web3,
			fulfillAmount: Number(order.take.amount),
			permit: "0x",
		});
	if (signal.aborted) return undefined;

	console.log(fulfillIx);

	const txId = await providers[order.take.chainId].sendTransaction(fulfillIx);
	console.log(`Fulfill: ${txId} `);

	const web3Payload =
		order.give.chainId === ChainId.Solana
			? {
				web3: providers[order.take.chainId].connection as Web3,
			}
			: undefined;
	let state = await client.getTakeOrderStatus(order, web3Payload);
	while (state === null || state.status !== OrderState.Fulfilled) {
		state = await client.getTakeOrderStatus(order, web3Payload);
		await helpers.sleep(2000);
	}

	let unlockIx;
	if (order.take.chainId === ChainId.Solana)
		unlockIx = await client.sendUnlockOrder<ChainId.Solana>(order, beneficiaryMap.get(order.give.chainId)!, fees.executionFees.claimCost + fees.executionFees.executionCost, {
			unlocker: (providers[order.take.chainId].wallet as { publicKey: PublicKey }).publicKey,
		});
	else
		unlockIx = await client.sendUnlockOrder<ChainId.Polygon>(order, beneficiaryMap.get(order.give.chainId)!, fees.executionFees.claimCost + fees.executionFees.executionCost, {
			web3: providers[order.take.chainId].connection as Web3,
			reward: fees.executionFees.claimCost.toString(),
		});

	const txId2 = await providers[order.take.chainId].sendTransaction(unlockIx);
	console.log(`Send unlock: ${txId2} `);

}

async function main() {
	const [config, enabledChains] = readEnv();

	const taskMap = new Map<string, ReturnType<typeof wrapIntoAbortController>>();
	const orderBroker = new RabbitNextOrder({ QUEUE_NAME: config.QUEUE_NAME, RABBIT_URL: config.RABBIT_URL }, enabledChains, config.CREATED_EVENT_TIMEOUT);

	const adapters = {} as AdapterContainer;
	const pmmClient = new PMMClient({});
	const beneficiaryMap: Map<ChainId, string> = new Map();

	type EvmChainInfo = NonNullable<ConstructorParameters<typeof Evm.PmmEvmClient>[0]>["addresses"];
	const evmAddresses = {} as EvmChainInfo;

	for (const chain of enabledChains) {
		if (chain === ChainId.Solana) {
			adapters[chain] = new SolanaProvider(
				new Connection(config[chain].RPC_URL),
				Keypair.fromSecretKey(helpers.hexToBuffer(config[chain].WALLET)),
			);
			pmmClient.updateClient(
				chain,
				new Solana.PmmClient(
					adapters[chain].connection as Connection,
					config[chain].PMM_SRC,
					config[chain].PMM_DST,
					config[chain].DEBRIDGE,
					config[chain].DEBRIDGE_SETTINGS!,
				),
			);
		} else {
			const web3 = new Web3(config[chain].RPC_URL);
			const account = web3.eth.accounts.privateKeyToAccount(config[chain].WALLET);
			web3.eth.accounts.wallet.add(account);
			web3.eth.defaultAccount = account.address;
			adapters[chain] = new EvmProvider(web3);
			evmAddresses[chain] = {
				deBridgeGateAddress: config[chain].DEBRIDGE,
				pmmDestinationAddress: config[chain].PMM_DST,
				pmmSourceAddress: config[chain].PMM_SRC,
			} as EvmChainInfo[number];
		}
		beneficiaryMap.set(chain, config[chain].BENEFICIARY);
	}

	const evmClient = new Evm.PmmEvmClient({ addresses: evmAddresses, enableContractsCache: true });
	for (const chain of Object.keys(evmAddresses)) {
		pmmClient.updateClient(Number(chain), evmClient);
	}

	await orderBroker.init();
	const takers = enabledChains.map((chain) => adapters[chain].address);
	console.log(takers);

	while (true) {
		const { order, orderId, type, taker } = await orderBroker.getNextOrder();
		console.log(type, order);
		if (type === "created") {
			taskMap.set(
				orderId,
				wrapIntoAbortController(orderProcessor, pmmClient, beneficiaryMap, adapters, order!, feed, checker, config.EXPECTED_PROFIT),
			);
		} else {
			const task = taskMap.get(orderId);
			if (task === undefined) continue;
			if (type === "fulfilled" && takers.includes(taker!)) continue;
			task?.abort();

		}
	}
}

main()
	.then(() => { })
	.catch(console.error);
