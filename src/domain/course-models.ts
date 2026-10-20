/**
 * 课程层（Course Layer）领域模型的**再导出**边界。
 *
 * 单独一个文件的理由：`CourseExposureEvent` 被**服务层**（course-exposure）
 * 与**领域层**（paper-freshness）共同消费。让它们都从这一个窄入口 import，
 * 而不是各自 `@/domain/models`（那会把 Expert 台账的类型一起拖进来）。
 *
 * 定义仍然在 `./models` —— 单一事实来源，这里只是转发。
 */

export type { CourseExposureEvent } from "./models";
