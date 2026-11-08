export const role = () => localStorage.getItem('cqa-role') === 'reviewer' ? 'reviewer' : 'operator';
