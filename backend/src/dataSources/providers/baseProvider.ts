import type { DataProviderResult, DataSourceInfo } from "../sourceTypes.js";

export interface DataProvider<TInput, TOutput> {
  sourceInfo(): DataSourceInfo;
  canHandle(input: TInput): boolean;
  fetch(input: TInput): Promise<DataProviderResult<TOutput>>;
}

