# DLN executor

DLN executor is the rule-based daemon service developed to automatically execute orders placed on the deSwap Liquidity Network (DLN) across supported blockchains.

- [About](#about)
- [Installation](#installation)
- [Configuration](#configuration)
	- [Orders feed](#orders-feed)
	- [Order validators](#order-validators)
	- [Order processor](#order-processor)
	- [Supported chains](#supported-chains)
	- [Price service](#price-service)
- [Logs](#logs)

## About

In a nutshell, DLN is an on-chain system of smart contracts where users (we call them *makers*) place their cross-chain exchange orders, giving a specific amount of input token on the source chain (`giveAmount` of the `giveToken` on the `giveChain`) and specifying the outcome they are willing to take on the destination chain (`takeAmount` of the `takeToken` on the `takeChain`). The given amount is being locked by the DLN smart contract on the source chain, and anyone with enough liquidity (called *takers*) can attempt to fulfill the order by calling the DLN smart contract on the destination chain supplying requested amount of tokens the *maker* is willing to take. After the order is being fulfilled, a cross-chain message is sent to the source chain via the deBridge protocol to unlock the funds, effectively completing the order.

This package is intended to automate the process of order execution: it listens for new orders coming into DLN, filters out those that satisfy custom criteria defined in the config (for example, expected profitability, amount cap, etc), attempts to fulfill them, and unlocks the funds.

## Installation

Download the source code from Github, picking the specific version:

```sh
git clone --depth 1 --single-branch --branch v0.2.1 git@github.com:debridge-finance/dln-executor.git
```

`cd` to the directory and install necessary production dependencies:

```sh
cd dln-executor
npm install --prod
```

Create a configuration file based on the `sample.config.ts`:

```sh
cp sample.config.ts executor.config.ts
```

> 🔴 Currently, DLN is running on a fully operational mainnet pre-release environment codenamed "LIMA", consisting of custom set of smart contracts being deployed on the mainnet Solana, mainnet Polygon and mainnet BNB chains. Thus, the `sample.config.ts` file which uses the `CURRENT_ENVIRONMENT` macro is actually referring to `PRERELEASE_ENVIRONMENT_CODENAME_LIMA`, where all custom (non-production) smart contract addresses as well as the websocket server address are defined. See [predefined environment configurations](./src/environments.ts) for details.

Configure networks to listen to, define rules to filter out orders, set the wallets with the liquidity to fulfill orders with (see the next [section](#configuration)), then launch the executor specifying the name of the configuration file:

```sh
npm run executor executor.config.ts
```

This will keep the executor up and running, listening for new orders and executing those that satisfy the rules. A detailed execution log would appear in the console.

## Testing automated fulfillment

### Ensure you are using the proper environment

Currently, we’ve set up a fully operational pre-release environment codenamed “LIMA”, which consists of:
- deployed pre-release smart contracts on several mainnet chains (Solana, Polygon and BNB),
- an event broker to feed executor through the websocket connection with the information about new orders being placed on the DLN,
- an [order placement app](https://lima.debridge.io/pmm),
- an [order explorer](https://lima-explorer.debridge.io/orders) with order execution shortcuts.

At the time of writing this is the only environment where orders can be placed and executed, thus the `sample.config.ts` file which uses the `CURRENT_ENVIRONMENT` macro is actually referring to `PRERELEASE_ENVIRONMENT_CODENAME_LIMA`, where all custom (non-production) smart contract addresses as well as the websocket server address are defined. See [predefined environment configurations](./src/environments.ts) for details. This means no additional configuration is needed, however you can set an explicit reference to `PRERELEASE_ENVIRONMENT_CODENAME_LIMA` environment to prevent accidental switching to the production environment.

### Restricting orders from fulfillment

To prevent dln-executor from fulfilling third party orders but yours during testing, you can configure it to filter off unwanted orders by adding trusted address to the whitelist of receivers using the [`whitelistedReceiver`](#whitelistedreceiveraddresses-address) validator:

```ts
dstValidators: [
    // only fulfill orders which transfer funds to the given receiver address
    validators.whitelistedReceiver(['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'])
],
```

This will make `dln-executor` to fulfill orders with `receiver` property set you the given address.

### Placing new orders

You can use the [order placement app](https://lima.debridge.io/pmm) to place new orders. If you decided to use the `whitelistedReceiver` validator then don't forget to set the `receiver` property of an order with the trusted address.

## Preparing funds

For every EVM chain you would like to support (currently: only BNB and Polygon):
- Register the reserves-keeping address (its private key must be set as a `takerPrivateKey` in the configuration file) and load it with small amount of reserve tokens to be used for fulfillment (e.g., 100 USDC) and a small amount of native blockchain currency (e.g., 0.1 ETH) to pay gas for fulfillment transactions. `dln-executor` will attempt to atomically swap minimum necessary amount of reserve token with the requested token using the best market route picked by 1inch router during order fulfillment
- Register the unlock authority address (its private key must be set as an `unlockAuthorityPrivateKey` in the configuration file) and load it with a small amount of native blockchain currency (e.g. 0.1 ETH) to pay gas for order unlocking transactions
- Register the beneficiary address (its public key (address) must be as a `beneficiary`). This address will be used to retrieve funds unblocked from the orders you successfully fulfill. Orders created through our API would have only stablecoins locked as we are going to swap arbitrary input tokens to select stable coins.
- Set up allowances by approving two contracts (`DlnDestination` and `CrosschainForwarder`) to spend reserve tokens on behalf of the reserves-keeping address. This is a temporary requirement, as the next version of dln-executor will perform this operation automatically. The addresses of these contracts within the LIMA environment are:
    - Polygon
        - `0xceD226Cbc7B4473c7578E3b392427d09448f24Ae`
        - `0x4f824487f7C0AB5A6B8B8411E472eaf7dDef2BBd`
    - BNB
        - `0xceD226Cbc7B4473c7578E3b392427d09448f24Ae`
        - `0xce1705632Ced3A1d18Ed2b87ECe5B74526f59b8A`

For Solana chain:
- Register the reserves-keeping address (its private key must be set as a `takerPrivateKey` in the configuration file) and load it with small amount of reserve tokens to be used for fulfillment (e.g., 100 USDC) and a small amount of native blockchain currency (e.g., 1 SOL) to pay gas for fulfillment transactions. `dln-executor` will attempt to atomically swap minimum necessary amount of reserve token with the requested token using the best market route picked by Jupiter router during order fulfillment
- Register the beneficiary address (its public key (address) must be as a `beneficiary`). This address will be used to retrieve funds unblocked from the orders you successfully fulfill. Orders created through our API would have only stablecoins locked as we are going to swap arbitrary input tokens to select stable coins.



## Configuration

The config file should represent a Typescript module which exports an Object conforming the [`ExecutorConfig`](src/config.ts) type. This section describes how to configure its properties.

Since it is implied that the executor's config must have access to your private keys in order to sign and broadcast order fulfillment transactions, we kindly advice to put your private keys in the local `.env` file and refer them via the `process.env.*` object. For clarity, DLN executor is shipped with `sample.env` file which can be used as a foundation for your custom privacy-focused configuration strategy. First, copy the sample file:

```sh
cp sample.env .env
```

Then put sensitive values to the variables defined in this file, effectively reusing them in the configuration file. See the example:

```env
# File: .env

SOLANA_TAKER_PRIVATE_KEY=abc...

BNB_TAKER_PRIVATE_KEY=
BNB_UNLOCK_AUTHORITY_PRIVATE_KEY=
BNB_BENEFICIARY=
```

```ts
// File: executor.config.ts

{
    // ...

    // gets the value from the .env file from the corresponding line
    takerPrivateKey: `${process.env.SOLANA_TAKER_PRIVATE_KEY}`,

    // ...

    takerPrivateKey: `${process.env.BNB_TAKER_PRIVATE_KEY}`,
    unlockAuthorityPrivateKey: `${process.env.BNB_UNLOCK_AUTHORITY_PRIVATE_KEY}`,
    beneficiary: `${process.env.BNB_BENEFICIARY}`,

    // ...
}
```


### Orders feed

The executor engine must have the source of new orders that are being placed on the DLN smart contracts. There can be various source implementations feeding the flow of orders (e.g. RPC node, RabbitMQ, etc). deBridge maintains and provides a highly efficient websocket server for speedy order delivery, though you can implement your own order feed using the `IOrderFeed` interface.

```ts
const config: ExecutorConfig = {
    // use the custom ws address provided by deBridge.
    // Could be a URL to WSS or the IOrderFeed implementation as well
    orderFeed: environment.WSS,
}
```

### Order validators

As soon as the executor engine obtains the next order to execute, it passes it through the set of explicitly defined rules called *validators* before making an attempt to fulfill it.

Whenever the order is received, the executor applies three groups of validators:
1. the global set of validators, defined in the `validators` property
2. the set of validators defined in the `srcValidators` property from the configuration of the chain the order originating from
3. the set of validators defined in the `dstValidators` property from the configuration of the chain the order is targeting to

Each validator is just a simple async function which accepts an instance of the given order, and returns a boolean result indicating the approval. If, and only if each and every validator has approved the order, it is being passed to fulfillment.

Validators can be set globally using the `orderValidators` property, which means they will be called when executing an order from/to any supported chain. This is a useful way to define constraints applicable to all supported chains. For example, let's define the global expected profitability of an order:

```ts
const config: ExecutorConfig = {
    validators: [
        validators.takeAmountUsdEquivalentBetween(0, 10_000),
        // ...
    ],
}
```

Validators can be additionally applied per supported chain (more on this in the [section below](#chain-related-configuration)), giving the flexibility to set tight constraints on chain-specific context, for example filtering out orders whose input `giveToken` is from the given white list or whose USD equivalent of the outcome (`takeAmount`) is within a specific range:

```ts
const config: ExecutorConfig = {
    chains: [
        {
            chain: ChainId.BSC,

            // defines filters for orders coming FROM the BNB Chain
            srcValidators: [
                // if the order is coming from BNB chain, accept it only if BUSD is the giveToken
                validators.whitelistedGiveToken([
                    '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'
                ]),
            ],

            // defines filters for orders coming TO the BNB Chain
            dstValidators: [
                // fulfill orders on BNB only if the requested amount from $0 to $10,000
                validators.takeAmountUsdEquivalentBetween(0, 10_000),
            ],
        }
    ]
}
```

The engine provides a handy set of built in validators to cover most cases that may arise during fine tuning of the order executor. Each validator can be applied either globally or per-chain. This section covers all of them.


#### `srcChainDefined()`

Checks if the source chain for the given order is defined in the config. This validator is made for convenience because it won't be possible to fulfill an order if its source chain is not defined in the configuration file.

#### `dstChainDefined()`

Checks if the destination chain for the given order is defined in the config. This validator is made for convenience because it won't be possible to fulfill an order if its destination chain is not defined in the configuration file.

#### `disableFulfill()`

Prevents orders coming to the given chain from fulfillment. This validator is useful to filter off orders that are targeted to the chain you don't want to fulfill in, which is still needed to be presented in the configuration file to enable orders coming from this chain.

For example, you may want to fulfill orders on Solana and Ethereum, accepting orders coming from Solana, Ethereum, and Avalanche (but not others): this is possible by configuring:
- fulfillment rules for Solana and Ethereum,
- unlocking rules for Solana, Ethereum and Avalanche, and
- explicitly disabling fulfillment in Avalanche:

```ts
const config: ExecutorConfig = {
    chains: [
        {
            chain: ChainId.Avalanche,

            dstValidators: [
                disableFulfill()
            ],

            // ...
        },

        {
            chain: ChainId.Solana,

            // ...
        },

        {
            chain: ChainId.Ethereum,

            // ...
        },
    ]
}
```

#### `giveAmountUSDEquivalentBetween(minUSDEquivalent: number, maxUSDEquivalent: number)`

Checks if the USD equivalent of the order's unlock amount (amount given by the maker upon order creation, deducted by the fees) is in the given range. This validator is useful to filter off uncomfortable volumes, e.g. too low (e.g. less than $10) or too high (e.g., more than $100,000).

```ts
validators: [
    // accept orders with unlock amounts >$10 and <$100K
    validators.giveAmountUSDEquivalentBetween(10, 100_000),
],
```

#### `takeAmountUSDEquivalentBetween(minUSDEquivalent: number, maxUSDEquivalent: number)`

Checks if the USD equivalent of the order's requested amount (amount that should be supplied to fulfill the order successfully) is in the given range. This validator is useful to filter off uncomfortable volumes, e.g. too low (e.g. less than $10) or too high (e.g., more than $100,000).

```ts
validators: [
    // accept orders with unlock amounts >$10 and <$100K
    validators.takeAmountUSDEquivalentBetween(10, 100_000),
],
```

#### `whitelistedMaker(addresses: string[])`

Checks if the address who placed the order on the source chain is in the whitelist. This validator is useful to filter out orders placed by the trusted parties.

#### `whitelistedReceiver(addresses: address[])`

Checks if the receiver address set in the order is in the given whitelist. This validator is useful to filter out orders placed by the trusted parties.

```ts
dstValidators: [
    // only fulfill orders which transfer funds to the given receiver address
    validators.whitelistedReceiver(['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'])
],
```

#### `whitelistedGiveToken(addresses: string[])`

Checks if the order's locked token is in the whitelist. This validator is useful to target orders that hold only liquid tokens (e.g., ETH, USDC, etc).

```ts
const config: ExecutorConfig = {
    chains: [
        {
            chain: ChainId.Ethereum,

            srcValidators: [
                // if the order is coming from Ethereum chain, accept ETH and USDT only
                validators.whitelistedGiveToken([
                    '0x0000000000000000000000000000000000000000',
                    '0xdAC17F958D2ee523a2206206994597C13D831ec7'
                ]),
            ],
        }
    ]
}
```

#### `blacklistedGiveToken(addresses: string[])`

Checks if the order's locked token is not in the blacklist. This validator is useful to filter off orders that hold undesired and/or illiquid tokens.

#### `whitelistedTakeToken(addresses: string[])`

Checks if the order's requested token is in the whitelist. This validator is useful to target orders that request specific tokens.

#### `blacklistedTakeToken(addresses: string[])`

Checks if the order's requested token is not in the blacklist. This validator is useful to filter off orders that requested undesired and/or illiquid tokens.

#### Custom validator

Developing custom validator requires a basic knowledge of Javascript and preferably Typescript. All you need is to define an async function that conforms the [`OrderValidator`](src/config.ts) type. For example, a validator that checks if the order's receiver address (the address where the funds would be sent to) is known:

```ts
export function receiverKnown(knownReceiverAddress): OrderValidator {
  return async (order: OrderData, pmmClient: PMMClient, config: ExecutorConfig) => {
    return buffersAreEqual(order.receiver, convertAddressToBuffer(chainId, knownReceiverAddress));
  }
}
```

Then such validator can be used in the configuration:

```ts
validators: [
    receiverKnown("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")
],
```

### Order processor

After the order has successfully passed the validation, the executor attempts to fulfill the order by running the given order processor, which implements the fulfillment strategy. This package provides a basic set of extensible processors, that you can use depending on your needs.

A processor can be attached globally to the `orderProcessor` property, which means it will be used for processing valid orders on all supported chains, or it can be set per chain:

```ts
const config: ExecutorConfig = {
    // use strictProcessor for all chains defined in this list
    orderProcessor: strictProcessor(),

    chains: [
        {
            chain: ChainId.Ethereum,
        },

        {
            chain: ChainId.Solana,
        },

        {
            chain: ChainId.BSC,

            // explicitly use preswapProcessor for BNB chain
            orderProcessor: processors.processor(4 /*bps*/)
        },
    ]
}
```

### Supported chains

DLN is a cross-chain solution, and since each chain has its own peculiarities, you must explicitly define each chain where the orders you as a taker would like to execute are coming from/to. Even if you are going to fulfill orders in one particular chain (e.g., Solana), you MUST configure other chains you are ready process order from (e.g., Ethereum) to support order unlocking.

For example, you want to fulfill orders on Solana and Ethereum, accepting orders coming from Solana, Ethereum, and Avalanche (but not others): this is possible by configuring:
- fulfillment rules for Solana and Ethereum,
- unlocking rules for Solana, Ethereum and Avalanche, and
- explicitly disabling fulfillment in Avalanche.

DLN executor gives you a wide range of configuration options to meet your specific needs. To define chains, use the `chains` property to list all chains you are willing the executor to process:

```ts
const config: ExecutorConfig = {
    chains: [
        {/* chain 1 */},

        {/* chain ... */},

        {/* chain N */},
    ]
}
```

Each chain must contain a list of network-, chain- and taker-related stuff.

#### Network related configuration

For each chain, you must define it's ID and the url to the RPC node:

```ts
chains: [
    {
        chain: ChainId.Solana,
        chainRpc: "https://api.mainnet-beta.solana.com/",
    },
]
```

#### Chain related configuration

A configuration engine preserves a list of defaults representing the mainnet deployments of the DLN smart contracts per each chain. See [predefined environment configurations](./src/environments.ts) for details.

At the time of writing, DLN is running on a fully operational mainnet pre-release environment codenamed "LIMA", consisting of custom set of smart contracts being deployed on the mainnet Solana, mainnet Polygon and mainnet BNB chains. This is the only environment where orders can be placed and executed, thus the `sample.config.ts` file which uses the `CURRENT_ENVIRONMENT` macro is actually referring to `PRERELEASE_ENVIRONMENT_CODENAME_LIMA`, where all custom (non-production) smart contract addresses as well as the websocket server address are defined. This means no additional configuration is needed unless your config still refers the `CURRENT_ENVIRONMENT`, however you can set an explicit reference to `PRERELEASE_ENVIRONMENT_CODENAME_LIMA` environment to prevent accidental switching to the production environment.

#### Taker related configuration

> **Caution!** Properties from this section define sensitive data used by the DLN executor to operate reserve funds. Since it is implied that the executor's config must have access to your private keys in order to sign and broadcast order fulfillment transactions, we kindly advice to put your private keys in the local `.env` file and refer them via the `process.env.*` object. For clarity, DLN executor is shipped with `sample.env` file which can be used as a foundation for your custom privacy-focused configuration strategy.

The `beneficiary` property defines taker controlled address where the orders-locked funds (fulfilled on the other chains) would be unlocked to.

The `takerPrivateKey` property defines the private key with the reserve funds available to fulfill orders. The DLN executor will sign transactions on behalf of this address, effectively setting approval, transferring funds, performing swaps and fulfillments.

The `unlockAuthorityPrivateKey` property defines the private key to unlock successfully fulfilled orders. The DLN executor will sign transactions on behalf of this address, effectively unlocking the orders.

```ts
const config: ExecutorConfig = {
    chains: [
        {
            chain: ChainId.Solana,

            // if the order is created on Solana and fulfilled on another chain (e.g. Ethereum),
            // unlocked funds will be sent to this Solana address
            beneficiary: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",

            // if the order is created on another chain (e.g. Ethereum), DLN executor would attempt to fulfill
            // this order on behalf of this address
            // Warn! base58 representation of a private key.
            // Warn! For security reasons, put it to the .env file
            takerPrivateKey: `${process.env.SOLANA_TAKER_PRIVATE_KEY}`,

            // Warn! base58 representation of a private key.
            // Warn! For security reasons, put it to the .env file
            unlockAuthorityPrivateKey: `${process.env.SOLANA_TAKER_PRIVATE_KEY}`,
        },

        {
            chain: ChainId.Ethereum,

            // if the order is created on Ethereum and fulfilled on another chain (e.g. Solana),
            // unlocked funds will be sent to this Ethereum address
            beneficiary: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",

            // if the order is created on another chain (e.g. Solana), DLN executor would attempt to fulfill
            // this order on behalf of this address
            // Warn! base64 representation of a private key.
            // Warn! For security reasons, put it to the .env file
            takerPrivateKey: `${process.env.POLYGON_TAKER_PRIVATE_KEY}`,

            // if the order is created on another chain (e.g. Solana), DLN executor would unlock it
            // after successful fulfillment on behalf of this address
            // Warn! base64 representation of a private key.
            // Warn! For security reasons, put it to the .env file
            unlockAuthorityPrivateKey: `${process.env.POLYGON_UNLOCK_AUTHORITY_PRIVATE_KEY}`,
        },
    ]
}
```


### Price service

Most built in validators and rules applied to orders depend on the current market price of the tokens involved in the order. It is possible to set up a custom service responsible for obtaining current market prices, by setting the `tokenPriceService` property:

```ts
const config: ExecutorConfig = {
    tokenPriceService: new CoingeckoPriceFeed(apiKey),
}
```

## Logs

By default, DLN executor prints summary logs to the stdout, indicating the summary of order execution (validation and fulfillment). Example:

```
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Received, give 1500000000000000000000 of 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56 on chain=56, take 1485000000 of 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 on chain=137
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Validator srcChainDefined: approved, chain=56 defined
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Validator dstChainDefined: approved, chain=137 defined
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Validator giveAmountUSDEquivalentBetween: approved, give amount ($1500) within range [$10, $100000]
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Validator takeAmountUSDEquivalentBetween: approved, take amount ($1485) within range [$10, $100000]
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Validator whitelistedGiveToken: approved, give token 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56 is in the white list
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Validator blacklistedTakeToken: approved, take token 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 is not in the black list
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Validated: 7/7 passed
[Order 4d51b661-a05f-49d5-a2ea-699222deefbd] Processed preswapProcessor: fulfilled, swapped 4000000000000000000 of 0x0000000000000000000000000000000000000000 to 1485000000 of 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```
