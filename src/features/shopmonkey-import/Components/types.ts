import type {
  LoadRunView as LoadRun,
  ImportView as View,
  MappingView as Mapping,
} from '../Lib/importView.server'

/** fork (M8): what the import screen's actions answer, for its components. */
export type ImportView = View
export type MappingView = Mapping
export type LoadRunView = LoadRun
