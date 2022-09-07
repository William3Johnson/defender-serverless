import Serverless from 'serverless';

import { Logging } from 'serverless/classes/Plugin';
import { differenceWith } from 'lodash';

import Logger from '../utils/logger';

import {
  getSentinelClient,
  getAutotaskClient,
  getAdminClient,
  getRelayClient,
  constructSentinel,
  constructNotification,
  getTeamAPIkeysOrThrow,
  getStackName,
  getResourceID,
  getEquivalentResource,
  isSSOT,
} from '../utils';
import {
  DefenderAutotask,
  DefenderContract,
  DefenderNotification,
  DefenderRelayer,
  DefenderSentinel,
  DefenderRelayerApiKey,
  TeamKey,
  YAutotask,
  YContract,
  YNotification,
  YRelayer,
  YSecret,
  YSentinel,
  DeployOutput,
  DeployResponse,
  DefenderAPIError,
  ResourceType,
} from '../types';

export default class DefenderDeploy {
  serverless: Serverless;
  options: Serverless.Options;
  logging: Logging;
  log: any;
  hooks: any;
  teamKey?: TeamKey;

  constructor(serverless: Serverless, options: Serverless.Options, logging: Logging) {
    this.serverless = serverless;
    this.options = options;
    this.logging = logging;

    this.log = Logger.getInstance();

    this.hooks = {
      'before:deploy:deploy': () => this.validateKeys(),
      'deploy:deploy': this.deploy.bind(this),
    };
  }

  validateKeys() {
    this.teamKey = getTeamAPIkeysOrThrow(this.serverless);
  }

  private async deploySecrets(output: DeployOutput<string>) {
    const secrets: YSecret[] = this.serverless.service.resources.Resources.secrets;
    const client = getAutotaskClient(this.teamKey!);
    const retrieveExisting = () => client.listSecrets().then((r) => r.secretNames ?? []);

    await this.wrapper<YSecret, string>(
      this.serverless,
      'Secrets',
      secrets,
      retrieveExisting,
      // on update
      async (secret: YSecret, match: any) => {
        const entry = {
          [match]: secret,
        };
        await client.createSecrets({
          deletes: [],
          secrets: entry as any,
        });
        return {
          name: `Secret`,
          id: `${match}`,
          success: true,
          response: entry,
        };
      },
      // on create
      async (secret: YSecret, stackResourceId: string) => {
        const entry = {
          [stackResourceId.split('.')[1]]: secret,
        };
        await client.createSecrets({
          deletes: [],
          secrets: entry as any,
        });
        return {
          name: `Secret`,
          id: `${Object.keys(entry).join(', ')}`,
          success: true,
          response: entry,
        };
      },
      // on remove
      async (secrets: string[]) => {
        await client.createSecrets({
          deletes: secrets,
          secrets: {},
        });
      },
      // overrideMatchDefinition
      (a: string, b: YSecret) => a === (b as unknown as string),
      output,
    );
  }

  private async deployContracts(output: DeployOutput<DefenderContract>) {
    const contracts: YContract[] = this.serverless.service.resources.Resources.contracts;
    const client = getAdminClient(this.teamKey!);
    const retrieveExisting = () => client.listContracts();

    await this.wrapper<YContract, DefenderContract>(
      this.serverless,
      'Contracts',
      contracts,
      retrieveExisting,
      // on update
      async (_: YContract, match: DefenderContract) => {
        return {
          name: match.name,
          id: `${match.network}-${match.address}`,
          success: false,
          notice: `Skipping import - contract ${match.address} already exists on ${match.network}`,
        };
      },
      // on create
      async (contract: YContract, _: string) => {
        const importedContract = await client.addContract({
          name: contract.name,
          network: contract.network,
          address: contract.address,
          abi: contract.abi && JSON.stringify(contract.abi),
          natSpec: contract['nat-spec'] ? contract['nat-spec'] : undefined,
        });
        return {
          name: importedContract.name,
          id: `${importedContract.network}-${importedContract.address}`,
          success: true,
          response: importedContract,
        };
      },
      // on remove
      async (contracts: DefenderContract[]) => {
        await Promise.all(contracts.map(async (c) => await client.deleteContract(`${c.network}-${c.address}`)));
      },
      // overrideMatchDefinition
      (a: DefenderContract, b: YContract) => {
        return a.address === b.address && a.network === b.network;
      },
      output,
    );
  }

  private async deployRelayers(
    output: DeployOutput<DefenderRelayer> & {
      relayerKeys: DeployOutput<DefenderRelayerApiKey>;
    },
  ) {
    const relayers: YRelayer[] = this.serverless.service.resources.Resources.relayers;
    const client = getRelayClient(this.teamKey!);
    const retrieveExisting = () => client.list().then((r) => r.items);
    await this.wrapper<YRelayer, DefenderRelayer>(
      this.serverless,
      'Relayers',
      relayers,
      retrieveExisting,
      // on update
      async (relayer: YRelayer, match: DefenderRelayer) => {
        const updatedRelayer = await client.update(match.relayerId, {
          name: relayer.name,
          minBalance: relayer['min-balance'],
          policies: relayer.policy && {
            whitelistReceivers: relayer.policy['whitelist-receivers'],
            gasPriceCap: relayer.policy['gas-price-cap'],
            EIP1559Pricing: relayer.policy['eip1559-pricing'],
          },
        });

        // check existing keys and remove / create accordingly
        const existingRelayerKeys = await client.listKeys(match.relayerId);
        const configuredKeys = relayer['api-keys'];
        const inDefender = differenceWith(
          existingRelayerKeys,
          configuredKeys,
          (a: DefenderRelayerApiKey, b: string) => a.stackResourceId === getResourceID(match.stackResourceId!, b),
        );

        // delete key in Defender thats not defined in template
        if (isSSOT(this.serverless) && inDefender.length > 0) {
          this.log.info(`Unused resources found on Defender:`);
          this.log.info(JSON.stringify(inDefender, null, 2));
          this.log.progress('component-deploy-extra', `Removing resources from Defender`);
          await Promise.all(inDefender.map(async (key) => await client.deleteKey(match.relayerId, key.keyId)));
          this.log.success(`Removed resources from Defender`);
          output.relayerKeys.removed.push(...inDefender);
        }

        const inTemplate = differenceWith(
          configuredKeys,
          existingRelayerKeys,
          (a: string, b: DefenderRelayerApiKey) => getResourceID(match.stackResourceId!, a) === b.stackResourceId,
        );

        // create key in Defender thats defined in template
        if (inTemplate) {
          await Promise.all(
            inTemplate.map(async (key) => {
              const keyStackResource = getResourceID(match.stackResourceId!, key);
              const createdKey = await client.createKey(match.relayerId, keyStackResource);
              this.log.success(`Created API Key (${keyStackResource}) for Relayer (${match.relayerId})`);
              // writing to .serverless as this is in .gitIgnore by default to avoid accidentally committing this file
              const keyPath = `${process.cwd()}/.serverless/relayer-keys/${keyStackResource}.json`;
              await this.serverless.utils.writeFile(keyPath, JSON.stringify({ ...createdKey }, null, 2));
              this.log.info(`API Key details stored in ${keyPath}`, 1);
              output.relayerKeys.created.push(createdKey);
            }),
          );
        }

        return {
          name: updatedRelayer.stackResourceId!,
          id: updatedRelayer.relayerId,
          success: true,
          response: updatedRelayer,
        };
      },
      // on create
      async (relayer: YRelayer, stackResourceId: string) => {
        const relayers: YRelayer[] = this.serverless.service.resources.Resources.relayers;
        const existingRelayers = (await getRelayClient(this.teamKey!).list()).items;
        const maybeRelayer = getEquivalentResource<YRelayer | undefined, DefenderRelayer>(
          this.serverless,
          relayer['address-from-relayer'],
          relayers,
          existingRelayers,
        );

        const createdRelayer = await client.create({
          name: relayer.name,
          network: relayer.network,
          minBalance: relayer['min-balance'],
          useAddressFromRelayerId: maybeRelayer?.relayerId,
          policies: relayer.policy && {
            whitelistReceivers: relayer.policy['whitelist-receivers'],
            gasPriceCap: relayer.policy['gas-price-cap'],
            EIP1559Pricing: relayer.policy['eip1559-pricing'],
          },
          stackResourceId,
        });

        const relayerKeys = relayer['api-keys'];
        if (relayerKeys) {
          await Promise.all(
            relayerKeys.map(async (key) => {
              const keyStackResource = getResourceID(stackResourceId, key);
              const createdKey = await client.createKey(createdRelayer.relayerId, keyStackResource);
              this.log.success(`Created API Key (${keyStackResource}) for Relayer (${createdRelayer.relayerId})`);
              const keyPath = `${process.cwd()}/.serverless/relayer-keys/${keyStackResource}.json`;
              await this.serverless.utils.writeFile(keyPath, JSON.stringify({ ...createdKey }, null, 2));
              this.log.info(`API Key details stored in ${keyPath}`, 1);
              output.relayerKeys.created.push(createdKey);
            }),
          );
        }

        return {
          name: stackResourceId,
          id: createdRelayer.relayerId,
          success: true,
          response: createdRelayer,
        };
      },
      // on remove requires manual interaction
      undefined,
      undefined,
      output,
    );
  }

  private async deployNotifications(output: DeployOutput<DefenderNotification>) {
    const notifications: YNotification[] = this.serverless.service.resources.Resources.notifications;
    const client = getSentinelClient(this.teamKey!);
    const retrieveExisting = () => client.listNotificationChannels();

    await this.wrapper<YNotification, DefenderNotification>(
      this.serverless,
      'Notifications',
      notifications,
      retrieveExisting,
      // on update
      async (notification: YNotification, match: DefenderNotification) => {
        const updatedNotification = await client.updateNotificationChannel({
          ...constructNotification(notification, match.stackResourceId!),
          notificationId: match.notificationId,
        });
        return {
          name: updatedNotification.stackResourceId!,
          id: updatedNotification.notificationId,
          success: true,
          response: updatedNotification,
        };
      },
      // on create
      async (notification: YNotification, stackResourceId: string) => {
        const createdNotification = await client.createNotificationChannel(
          constructNotification(notification, stackResourceId),
        );
        return {
          name: stackResourceId,
          id: createdNotification.notificationId,
          success: true,
          response: createdNotification,
        };
      },
      // on remove
      async (notifications: DefenderNotification[]) => {
        await Promise.all(notifications.map(async (n) => await client.deleteNotificationChannel(n)));
      },
      undefined,
      output,
    );
  }

  private async deploySentinels(output: DeployOutput<DefenderSentinel>) {
    const sentinels: YSentinel[] = this.serverless.service.resources.Resources.sentinels;
    const client = getSentinelClient(this.teamKey!);
    const autotasks = await getAutotaskClient(this.teamKey!).list();
    const notifications = await client.listNotificationChannels();
    const retrieveExisting = () => client.list().then((r) => r.items);

    await this.wrapper<YSentinel, DefenderSentinel>(
      this.serverless,
      'Sentinels',
      sentinels,
      retrieveExisting,
      // on update
      async (sentinel: YSentinel, match: DefenderSentinel) => {
        const updatedSentinel = await client.update(
          match.subscriberId,
          constructSentinel(this.serverless, match.stackResourceId!, sentinel, notifications, autotasks.items),
        );
        return {
          name: updatedSentinel.stackResourceId!,
          id: updatedSentinel.subscriberId,
          success: true,
          response: updatedSentinel,
        };
      },
      // on create
      async (sentinel: YSentinel, stackResourceId: string) => {
        const createdSentinel = await client.create(
          constructSentinel(this.serverless, stackResourceId, sentinel, notifications, autotasks.items),
        );
        return {
          name: stackResourceId,
          id: createdSentinel.subscriberId,
          success: true,
          response: createdSentinel,
        };
      },
      // on remove
      async (sentinels: DefenderSentinel[]) => {
        await Promise.all(sentinels.map(async (s) => await client.delete(s.subscriberId)));
      },
      undefined,
      output,
    );
  }

  private async deployAutotasks(output: DeployOutput<DefenderAutotask>) {
    // @ts-ignore
    const autotasks: YAutotask[] = this.serverless.service.functions;
    const client = getAutotaskClient(this.teamKey!);
    const retrieveExisting = () => client.list().then((r) => r.items);

    await this.wrapper<YAutotask, DefenderAutotask>(
      this.serverless,
      'Autotasks',
      autotasks,
      retrieveExisting,
      // on update
      async (autotask: YAutotask, match: DefenderAutotask) => {
        // Get new code digest
        const code = await client.getEncodedZippedCodeFromFolder(autotask.path);
        const newDigest = client.getCodeDigest(code);

        // Get existing one
        const { codeDigest } = await client.get(match.autotaskId);
        const updatesAutotask = await client.update({
          autotaskId: match.autotaskId,
          name: autotask.name,
          paused: autotask.paused,
          trigger: {
            type: autotask.trigger.type,
            frequencyMinutes: autotask.trigger.frequency,
            cron: autotask.trigger.cron ?? undefined,
          },
        });

        if (newDigest === codeDigest) {
          return {
            name: match.stackResourceId!,
            id: match.autotaskId,
            success: true,
            notice: `Skipping upload - code digest matches for autotask ${match.stackResourceId}`,
            response: updatesAutotask,
          };
        } else {
          await client.updateCodeFromFolder(match.autotaskId, autotask.path);
          return {
            name: match.stackResourceId!,
            id: match.autotaskId,
            success: true,
            response: updatesAutotask,
          };
        }
      },
      // on create
      async (autotask: YAutotask, stackResourceId: string) => {
        const autotaskRelayer = autotask.relayer;
        const relayers: YRelayer[] = this.serverless.service.resources.Resources.relayers;
        const existingRelayers = (await getRelayClient(this.teamKey!).list()).items;
        const maybeRelayer = getEquivalentResource<YRelayer | undefined, DefenderRelayer>(
          this.serverless,
          autotaskRelayer,
          relayers,
          existingRelayers,
        );

        const createdAutotask = await client.create({
          name: autotask.name,
          trigger: {
            type: autotask.trigger.type,
            frequencyMinutes: autotask.trigger.frequency,
            cron: autotask.trigger.cron ?? undefined,
          },
          encodedZippedCode: await client.getEncodedZippedCodeFromFolder(autotask.path),
          paused: autotask.paused,
          relayerId: maybeRelayer?.relayerId,
          stackResourceId: stackResourceId,
        });
        return {
          name: stackResourceId,
          id: createdAutotask.autotaskId,
          success: true,
          response: createdAutotask,
        };
      },
      // on remove
      async (autotasks: DefenderAutotask[]) => {
        await Promise.all(autotasks.map(async (a) => await client.delete(a.autotaskId)));
      },
      undefined,
      output,
    );
  }

  private async wrapper<Y, D>(
    context: Serverless,
    resourceType: ResourceType,
    resources: Y[],
    retrieveExistingResources: () => Promise<D[]>,
    onUpdate: (resource: Y, match: D) => Promise<DeployResponse>,
    onCreate: (resource: Y, stackResourceId: string) => Promise<DeployResponse>,
    onRemove?: (resources: D[]) => Promise<void>,
    overrideMatchDefinition?: (a: D, b: Y) => boolean,
    output: DeployOutput<any> = { removed: [], created: [], updated: [] },
  ) {
    try {
      const stackName = getStackName(context);
      this.log.progress('component-deploy', `Initialising deployment of ${resourceType}`);
      this.log.notice(`${resourceType}`);

      const existing = await retrieveExistingResources();

      // only remove if template is considered single source of truth
      if (isSSOT(context) && onRemove) {
        const inDefenderButNotInTemplate = differenceWith(existing, Object.keys(resources), (a: any, b: any) =>
          overrideMatchDefinition ? overrideMatchDefinition(a, b) : a.stackResourceId === getResourceID(stackName, b),
        );

        if (inDefenderButNotInTemplate.length > 0) {
          this.log.info(`Unused resources found on Defender:`);
          this.log.info(JSON.stringify(inDefenderButNotInTemplate, null, 2));
          this.log.progress('component-deploy-extra', `Removing resources from Defender`);
          await onRemove(inDefenderButNotInTemplate);
          this.log.success(`Removed resources from Defender`);
          output.removed.push(...inDefenderButNotInTemplate);
        }
      }

      for (const [id, resource] of Object.entries(resources)) {
        // always refresh list after each addition as some resources rely on the previous one
        const existing = await retrieveExistingResources();

        const entryStackResourceId = getResourceID(stackName, id);
        let match;
        if (overrideMatchDefinition) {
          match = existing.find((e: D) =>
            resourceType === 'Secrets' ? overrideMatchDefinition(e, id as any) : overrideMatchDefinition(e, resource),
          );
        } else {
          match = existing.find((e: any) => e.stackResourceId === entryStackResourceId);
        }

        if (match) {
          this.log.progress(
            'component-deploy-extra',
            `Updating ${
              resourceType === 'Contracts'
                ? (match as unknown as DefenderContract).name
                : resourceType === 'Secrets'
                ? id
                : (match as D & { stackResourceId: string }).stackResourceId
            }`,
          );
          const result = await onUpdate(resource, match);
          if (result.success) {
            this.log.success(`Updated ${result.name} (${result.id})`);
            output.updated.push(result.response);
          }
          if (result.notice) this.log.info(`${result.notice}`, 1);
          if (result.error) this.log.error(`${result.error}`);
        } else {
          this.log.progress(
            'component-deploy-extra',
            `Creating ${resourceType === 'Secrets' ? id : entryStackResourceId}`,
          );
          const result = await onCreate(resource, entryStackResourceId);
          if (result.success) {
            this.log.success(`Created ${result.name} (${result.id})`);
            output.created.push(result.response);
          }
          if (result.notice) this.log.info(`${result.notice}`, 1);
          if (result.error) this.log.error(`${result.error}`);
        }
      }
    } catch (e) {
      try {
        this.log.error(((e as DefenderAPIError).response.data as any).message);
      } catch {
        this.log.error(e);
      }
    }
  }

  public async deploy() {
    this.log.notice('========================================================');
    const stackName = getStackName(this.serverless);
    this.log.progress('deploy', `Running Defender Deploy on stack: ${stackName}`);

    const sentinels: DeployOutput<DefenderSentinel> = {
      removed: [],
      created: [],
      updated: [],
    };
    const autotasks: DeployOutput<DefenderAutotask> = {
      removed: [],
      created: [],
      updated: [],
    };
    const contracts: DeployOutput<DefenderContract> = {
      removed: [],
      created: [],
      updated: [],
    };
    const notifications: DeployOutput<DefenderNotification> = {
      removed: [],
      created: [],
      updated: [],
    };
    const secrets: DeployOutput<string> = {
      removed: [],
      created: [],
      updated: [],
    };
    const relayers: DeployOutput<DefenderRelayer> & {
      relayerKeys: DeployOutput<DefenderRelayerApiKey>;
    } = {
      removed: [],
      created: [],
      updated: [],
      relayerKeys: {
        removed: [],
        created: [],
        updated: [],
      },
    };

    const stdOut = {
      stack: stackName,
      timestamp: new Date().toISOString(),
      sentinels,
      autotasks,
      contracts,
      relayers,
      notifications,
      secrets,
    };
    await this.deploySecrets(stdOut.secrets);
    await this.deployContracts(stdOut.contracts);
    // Always deploy relayers before autotasks
    await this.deployRelayers(stdOut.relayers);
    await this.deployAutotasks(stdOut.autotasks);
    // Deploy notifications before sentinels
    await this.deployNotifications(stdOut.notifications);
    await this.deploySentinels(stdOut.sentinels);

    this.log.notice('========================================================');

    this.log.stdOut(JSON.stringify(stdOut, null, 2));

    await this.serverless.utils.appendFileSync(
      `${process.cwd()}/.serverless/deployment-log.${stackName}.json`,
      JSON.stringify(stdOut, null, 0) + '\r\n',
    );
  }
}