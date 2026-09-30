import { describe, expect, it } from 'vitest';
import type { NormalizedVm } from '../api/types';
import { summaryParts } from './Summary';

const vm = (state: NormalizedVm['state'], publicIps: string[], labels: Record<string, string>) =>
  ({ state, network: { publicIps }, labels }) as unknown as NormalizedVm;

describe('summaryParts', () => {
  it('demo filosunu tek satırda özetler', () => {
    const fleet = [vm('running', ['35.254.243.8'], {}), vm('stopped', [], { owner: 'bengu' }), vm('stopped', [], { owner: 'bengu' })];
    expect(summaryParts(fleet)).toEqual(['1 çalışıyor', '2 durdurulmuş', "1 dış IP'li", "1 VM'de owner label'ı yok"]);
  });

  it('sıfır olan riskleri yazmaz, geçişteki VM\'leri ayrıca sayar', () => {
    expect(summaryParts([vm('pending', [], { owner: 'x' })])).toEqual(['0 çalışıyor', '0 durdurulmuş', '1 geçişte']);
  });
});
