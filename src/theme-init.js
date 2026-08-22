// Theme vor dem ersten Paint setzen (kein Aufblitzen); Standard: dunkel.
const mode = localStorage.getItem('term-theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = mode;
document.querySelector('meta[name="color-scheme"]').content = mode;
