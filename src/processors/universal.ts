import {
  calculateExpectedTakeAmount,
  ChainId,
  evm,
  OrderData,
  OrderState,
  tokenAddressToString,
} from "@debridge-finance/dln-client";
import { Logger } from "pino";
import Web3 from "web3";

import { OrderInfoStatus } from "../enums/order.info.status";
import { IncomingOrderContext } from "../interfaces";
import { createClientLogger } from "../logger";
import { EvmAdapterProvider } from "../providers/evm.provider.adapter";
import { SolanaProviderAdapter } from "../providers/solana.provider.adapter";

import {
  BaseOrderProcessor,
  OrderProcessorContext,
  OrderProcessorInitContext,
  OrderProcessorInitializer,
} from "./base";
import { MempoolService } from "./mempool.service";
import { approveToken } from "./utils/approve";

export type UniversalProcessorParams = {
  minProfitabilityBps: number;
  mempoolInterval: number;
};

class UniversalProcessor extends BaseOrderProcessor {
  private mempoolService: MempoolService;
  private priorityQueue = new Set<string>();
  private queue = new Set<string>();
  private ordersMap = new Map<string, IncomingOrderContext>();

  private isLocked: boolean = false;
  private params: UniversalProcessorParams = {
    minProfitabilityBps: 4,
    mempoolInterval: 60, // every 60s
  };

  constructor(params?: Partial<UniversalProcessorParams>) {
    super();
    Object.assign(this.params, params || {});
  }

  async init(
    chainId: ChainId,
    context: OrderProcessorInitContext
  ): Promise<void> {
    this.chainId = chainId;
    this.context = context;

    this.mempoolService = new MempoolService(
      context.logger.child({ universalProcessorChain: chainId }),
      this.process.bind(this),
      this.params.mempoolInterval
    );

    if (chainId !== ChainId.Solana) {
      const tokens: string[] = [];
      context.buckets.forEach((bucket) => {
        const tokensFromBucket = bucket.findTokens(this.chainId) || [];
        tokensFromBucket.forEach((token) => {
          tokens.push(tokenAddressToString(this.chainId, token));
        });
      });

      const client = context.takeChain.client as evm.PmmEvmClient;
      await Promise.all([
        ...tokens.map((token) =>
          approveToken(
            chainId,
            token,
            client.getContractAddress(
              chainId,
              evm.ServiceType.CrosschainForwarder
            ),
            context.takeChain.fulfullProvider as EvmAdapterProvider,
            context.logger
          )
        ),
        ...tokens.map((token) =>
          approveToken(
            chainId,
            token,
            client.getContractAddress(chainId, evm.ServiceType.Destination),
            context.takeChain.fulfullProvider as EvmAdapterProvider,
            context.logger
          )
        ),
      ]);
    }
  }

  async process(params: IncomingOrderContext): Promise<void> {
    const { context, orderInfo } = params;
    const { orderId, type } = orderInfo;

    params.context.logger = context.logger.child({
      processor: "universalProcessor",
      orderId,
    });

    switch (type) {
      case OrderInfoStatus.archival:
      case OrderInfoStatus.created: {
        return this.tryProcess(params);
      }

      case OrderInfoStatus.cancelled:
      case OrderInfoStatus.fulfilled: {
        this.queue.delete(orderId);
        this.priorityQueue.delete(orderId);
        this.ordersMap.delete(orderId);
        this.mempoolService.delete(orderId);
        context.logger.debug(`deleted from queues`);
        return;
      }

      case OrderInfoStatus.other:
      default: {
        context.logger.error(
          `status=${OrderInfoStatus[type]} not implemented, skipping`
        );
        return;
      }
    }
  }

  private async tryProcess(params: IncomingOrderContext): Promise<void> {
    const { context, orderInfo } = params;
    const { orderId } = orderInfo;

    // already processing an order
    if (this.isLocked) {
      context.logger.debug(
        `Processor is currently processing an order, postponing`
      );

      switch (params.orderInfo.type) {
        case OrderInfoStatus.archival: {
          this.queue.add(orderId);
          context.logger.debug(`postponed to secondary queue`);
          break;
        }
        case OrderInfoStatus.created: {
          this.priorityQueue.add(orderId);
          context.logger.debug(`postponed to primary queue`);
          break;
        }
        default:
          throw new Error(
            `Unexpected order status: ${OrderInfoStatus[params.orderInfo.type]}`
          );
      }
      this.ordersMap.set(orderId, params);
      return;
    }

    // process this order
    this.isLocked = true;
    try {
      await this.processOrder(params);
    } catch (e) {
      context.logger.error(`processing ${orderId} failed with error: ${e}`, e);
    }
    this.isLocked = false;

    // forward to the next order
    // TODO try to get rid of recursion here. Use setInterval?
    const nextOrder = this.pickNextOrder();
    if (nextOrder) {
      this.tryProcess(nextOrder);
    }
  }

  private pickNextOrder() {
    const nextOrderId =
      this.priorityQueue.values().next().value ||
      this.queue.values().next().value;

    if (nextOrderId) {
      const order = this.ordersMap.get(nextOrderId);

      this.priorityQueue.delete(nextOrderId);
      this.queue.delete(nextOrderId);
      this.ordersMap.delete(nextOrderId);

      return order;
    }
  }

  private async processOrder(
    params: IncomingOrderContext
  ): Promise<void | never> {
    const { orderInfo, context } = params;
    const { orderId, order } = orderInfo;
    const logger = params.context.logger;

    if (!order || !orderId) {
      logger.error("order is empty, should not happen");
      throw new Error("order is empty, should not happen");
    }

    const bucket = context.config.buckets.find(
      (bucket) =>
        bucket.findFirstToken(order.give.chainId) !== undefined &&
        bucket.findFirstToken(order.take.chainId) !== undefined
    );
    if (bucket === undefined) {
      throw new Error(
        "no token bucket effectively covering both chains. Seems like no reserve tokens are configured to fulfill orders"
      );
    }

    const client = context.config.client;
    // validate that order is not fullfilled
    const takeOrderStatus = await client.getTakeOrderStatus(
      orderId,
      params.orderInfo.order!.take.chainId,
      { web3: this.context.takeChain.fulfullProvider.connection as Web3 }
    );
    if (takeOrderStatus?.status !== OrderState.NotSet) {
      throw new Error("Order is fulfilled");
    }

    // validate that order is created
    const giveOrderStatus = await client.getGiveOrderStatus(
      params.orderInfo.orderId,
      params.orderInfo.order!.give.chainId,
      { web3: context.giveChain.fulfullProvider.connection as Web3 }
    );
    if (giveOrderStatus?.status !== OrderState.Created) {
      throw new Error("Order is not created");
    }

    const {
      reserveDstToken,
      requiredReserveDstAmount,
      isProfitable,
      reserveToTakeSlippageBps,
    } = await calculateExpectedTakeAmount(
      order,
      this.params.minProfitabilityBps,
      {
        client: context.config.client,
        giveConnection: context.giveChain.fulfullProvider.connection as Web3,
        takeConnection: this.context.takeChain.fulfullProvider
          .connection as Web3,
        priceTokenService: context.config.tokenPriceService,
        buckets: context.config.buckets,
        swapConnector: context.config.swapConnector,
        logger: createClientLogger(logger),
      }
    );

    if (!isProfitable) {
      logger.info("order is not profitable, postponing it to the mempool");
      this.mempoolService.addOrder({ orderInfo, context });
      return;
    }

    const fees = await this.getFee(order, context);
    const executionFeeAmount = await context.config.client.getAmountToSend(
      order.take.chainId,
      order.give.chainId,
      fees.executionFees.total,
      this.context.takeChain.fulfullProvider.connection as Web3
    );

    // fulfill order
    const fulfillTx = await this.createOrderFullfillTx(
      orderId,
      order,
      reserveDstToken,
      requiredReserveDstAmount,
      reserveToTakeSlippageBps,
      context,
      logger
    );

    try {
      const txFulfill =
        await this.context.takeChain.fulfullProvider.sendTransaction(
          fulfillTx.tx,
          { logger }
        );
      logger.info(`fulfill transaction ${txFulfill} is completed`);
    } catch (e) {
      logger.error(`fulfill transaction failed: ${e}`);
      this.mempoolService.addOrder({ orderInfo, context });
      return;
    }

    await this.waitIsOrderFulfilled(orderId, order, context, logger);

    // unlocking
    // const beneficiary = context.giveChain.beneficiary;
    // const unlockTx = await this.createOrderUnlockTx(
    //   orderId,
    //   order,
    //   beneficiary,
    //   executionFeeAmount,
    //   fees,
    //   context,
    //   logger
    // );
    // const txUnlock =
    //   await this.context.takeChain.unlockProvider.sendTransaction(unlockTx, {
    //     logger,
    //   });
    // logger.info(`unlock transaction ${txUnlock} is completed`);
  }

  private async createOrderUnlockTx(
    orderId: string,
    order: OrderData,
    beneficiary: string,
    executionFeeAmount: bigint,
    fees: any,
    context: OrderProcessorContext,
    logger: Logger
  ) {
    // todo fix any
    let unlockTxPayload: any;
    if (order.take.chainId === ChainId.Solana) {
      const wallet = (
        this.context.takeChain.unlockProvider as SolanaProviderAdapter
      ).wallet.publicKey;
      unlockTxPayload = {
        unlocker: wallet,
      };
    } else {
      const rewards =
        order.give.chainId === ChainId.Solana
          ? {
              reward1: fees.executionFees.rewards[0].toString(),
              reward2: fees.executionFees.rewards[1].toString(),
            }
          : {
              reward1: "0",
              reward2: "0",
            };
      unlockTxPayload = {
        web3: (this.context.takeChain.unlockProvider as EvmAdapterProvider)
          .connection,
        ...rewards,
      };
    }
    unlockTxPayload.loggerInstance = createClientLogger(logger);

    const unlockTx =
      await context.config.client.sendUnlockOrder<ChainId.Solana>(
        order,
        orderId,
        beneficiary,
        executionFeeAmount,
        unlockTxPayload
      );
    logger.debug(
      `unlockTx is created in ${order.take.chainId} ${JSON.stringify(unlockTx)}`
    );

    return unlockTx;
  }

  private async createOrderFullfillTx(
    orderId: string,
    order: OrderData,
    reserveDstToken: Uint8Array,
    reservedAmount: string,
    reserveToTakeSlippageBps: number | null,
    context: OrderProcessorContext,
    logger: Logger
  ) {
    let fullFillTxPayload: any;
    if (order.take.chainId === ChainId.Solana) {
      const wallet = (
        this.context.takeChain.fulfullProvider as SolanaProviderAdapter
      ).wallet.publicKey;
      fullFillTxPayload = {
        taker: wallet,
      };
    } else {
      fullFillTxPayload = {
        web3: this.context.takeChain.fulfullProvider.connection,
        permit: "0x",
        takerAddress: this.context.takeChain.fulfullProvider.address,
        unlockAuthority: this.context.takeChain.unlockProvider.address,
      };
    }
    fullFillTxPayload.swapConnector = context.config.swapConnector;
    fullFillTxPayload.reservedAmount = reservedAmount;
    fullFillTxPayload.slippageBps = reserveToTakeSlippageBps;
    fullFillTxPayload.loggerInstance = createClientLogger(logger);
    const fulfillTx = await context.config.client.preswapAndFulfillOrder(
      order,
      orderId,
      reserveDstToken,
      fullFillTxPayload
    );
    logger.debug(
      `fulfillTx is created in ${order.take.chainId} ${JSON.stringify(
        fulfillTx
      )}`
    );

    return fulfillTx;
  }
}

export const universalProcessor = (
  params?: Partial<UniversalProcessorParams>
): OrderProcessorInitializer => {
  return async (chainId: ChainId, context: OrderProcessorInitContext) => {
    const processor = new UniversalProcessor(params);
    await processor.init(chainId, context);
    return processor;
  };
};
