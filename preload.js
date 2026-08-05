const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 文件夹选择与状态
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getState: () => ipcRenderer.invoke('get-state'),
  resetState: () => ipcRenderer.invoke('reset-state'),

  // 深度扫描（支持完整性检测选项，以及进度事件）
  deepScan: (opts) => ipcRenderer.invoke('deep-scan', opts),
  onScanProgress: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (e, data) => handler(data);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },

  // 锚定保护
  getAnchors: () => ipcRenderer.invoke('get-anchors'),
  addAnchor: (paths) => ipcRenderer.invoke('add-anchor', paths),
  removeAnchor: (p) => ipcRenderer.invoke('remove-anchor', p),
  getRootFolders: () => ipcRenderer.invoke('get-root-folders'),

  // 重复排查
  scanDuplicates: () => ipcRenderer.invoke('scan-duplicates'),
  markKeep: (paths) => ipcRenderer.invoke('mark-keep', paths),
  unmarkKeep: (paths) => ipcRenderer.invoke('unmark-keep', paths),
  cleanDuplicates: () => ipcRenderer.invoke('clean-duplicates'),

  // 冲突检测
  scanConflicts: () => ipcRenderer.invoke('scan-conflicts'),
  addWhitelist: (keys) => ipcRenderer.invoke('add-whitelist', keys),
  removeWhitelist: (key) => ipcRenderer.invoke('remove-whitelist', key),
  getWhitelist: () => ipcRenderer.invoke('get-whitelist'),
  // 冲突文件删除
  deleteConflictFile: (filePath) => ipcRenderer.invoke('delete-conflict-file', filePath),

  // 翻译识别（支持仅翻译选中文件、跳过已翻译、强制重新翻译）
  scanTranslation: (opts) => ipcRenderer.invoke('scan-translation', opts),
  // 手动修改中文名称（全局联动，写入本地索引）
  setChineseName: (modPath, chineseName) => ipcRenderer.invoke('set-chinese-name', modPath, chineseName),

  // 分类与打标签
  setClassification: (modPath, classification) => ipcRenderer.invoke('set-classification', modPath, classification),
  getClassifications: () => ipcRenderer.invoke('get-classifications'),
  getCategories: () => ipcRenderer.invoke('get-categories'),
  addCategory: (parentPath, name) => ipcRenderer.invoke('add-category', parentPath, name),
  addTag: (tag) => ipcRenderer.invoke('add-tag', tag),
  getTags: () => ipcRenderer.invoke('get-tags'),
  removeTag: (tag) => ipcRenderer.invoke('remove-tag', tag),

  // 创建并移动
  executeMove: () => ipcRenderer.invoke('execute-move'),

  // 图片预览
  getImages: (folderPath) => ipcRenderer.invoke('get-images', folderPath),

  // 一键定位
  locateFile: (filePath) => ipcRenderer.invoke('locate-file', filePath),

  // 损坏检测报告导出
  exportDamagedReport: () => ipcRenderer.invoke('export-damaged-report'),

  // 严格模式开关
  setStrictMode: (enabled) => ipcRenderer.invoke('set-strict-mode', enabled),

  // 翻译配置
  getTranslationConfig: () => ipcRenderer.invoke('get-translation-config'),
  setTranslationConfig: (config) => ipcRenderer.invoke('set-translation-config', config),
  testTranslation: (text) => ipcRenderer.invoke('test-translation', text),

  // 翻译进度监听
  onTranslationProgress: (handler) => {
    const listener = (e, data) => handler(data);
    ipcRenderer.on('translation-progress', listener);
    return () => ipcRenderer.removeListener('translation-progress', listener);
  },
});
