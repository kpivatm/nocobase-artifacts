import { tExpr as _tExpr, useFlowEngine } from '@nocobase/flow-engine';
// @ts-ignore
import pkg from './../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return (str: string, params?: Record<string, unknown>) =>
    engine.context.t(str, { ns: [pkg.name, 'client'], ...params });
}

export function tExpr(key: string) {
  return _tExpr(key, { ns: [pkg.name, 'client'] });
}
