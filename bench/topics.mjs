export const topics = [
  ["Rust language", "Rust programming language", "en", "Rust_(programming_language)"],
  ["Internet addressing", "IPv6", "en", "IPv6"],
  ["Planet astronomy", "Mercury planet", "en", "Mercury_(planet)"],
  ["Solar eclipse", "Солнечное затмение", "ru", "Солнечное_затмение"],
  ["Russian literature", "Александр Пушкин", "ru", "Пушкин,_Александр_Сергеевич"],
  ["Mars rover", "Mars rover Curiosity", "en", "Curiosity_(rover)"],
  ["Space probe", "Voyager 1 spacecraft", "en", "Voyager_1"],
  ["Encrypted transport", "Transport Layer Security", "en", "Transport_Layer_Security"],
  ["Binary search", "Двоичный поиск", "ru", "Двоичный_поиск"],
  ["Database", "PostgreSQL", "en", "PostgreSQL"],
  ["Pathfinding", "A star search algorithm", "en", "A*_search_algorithm"],
  ["Geometry", "Теорема Пифагора", "ru", "Теорема_Пифагора"],
];

export function isReference(input, language, article) {
  try {
    const url = new URL(input);
    return url.hostname === language + ".wikipedia.org"
      && decodeURIComponent(url.pathname).toLowerCase() === ("/wiki/" + article).toLowerCase();
  } catch {
    return false;
  }
}
