type AnnotationType = 'error' | 'warning' | 'notice';

interface AnnotationOptions {
    file?: string;
    line?: number;
    col?: number;
    title?: string;
}

/**
 * 输出 GitHub Actions 注解到标准输出
 * @param type 注解类型：'error' | 'warning' | 'notice'
 * @param message 注解内容
 * @param options 可选参数，支持 file, line, col, title
 */
export default function githubAnnotation(
    type: AnnotationType,
    message: string,
    options: AnnotationOptions = {}
): void {
    let meta = '';
    // 构建 key=value,key2=value2 格式
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && value !== null && value !== '') {
            if (meta) meta += ',';
            meta += `${key}=${value}`;
        }
    }
    const annotation = meta
        ? `::${type} ${meta}::${message}`
        : `::${type}::${message}`;
    // 输出到标准输出
    // Actions runner 会自动识别这些语法
    console.log(annotation);
}
