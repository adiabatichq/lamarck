import type { TriggerCoordinator } from './coordinator';

/** The one control-plane dispatcher used by trusted Console and Host CLI. */
export async function manageTriggers(coordinator: TriggerCoordinator, operation: string, input: Record<string, unknown>, host: boolean): Promise<unknown> {
  if (!host) throw Object.assign(new Error('Trigger management requires Host authority'), { code: 'CLI_UNSUPPORTED_COMMAND' });
  const id = input.triggerId as string;
  switch (operation) {
    case 'trigger.targets': return coordinator.catalog();
    case 'trigger.list': return coordinator.list();
    case 'trigger.inspect': return coordinator.inspect(id);
    case 'trigger.create': return coordinator.create({ enabled: false, ...input.config as Record<string, unknown> });
    case 'trigger.update': return coordinator.update(id, input.revision as number ?? coordinator.store.get(id).revision, input.config);
    case 'trigger.enable': case 'trigger.disable': return coordinator.enable(id, operation === 'trigger.enable', input.revision as number | undefined);
    case 'trigger.delete': return coordinator.remove(id, input.revision as number ?? coordinator.store.get(id).revision);
    case 'trigger.preview': return coordinator.preview(input.config ?? coordinator.store.get(id).settings, input.limit as number | undefined);
    case 'trigger.runs': return coordinator.history(id, input.limit as number | undefined);
    case 'trigger.cancel': return coordinator.cancelRun(input.runId as string);
    default: throw new Error('Unknown Trigger operation');
  }
}
