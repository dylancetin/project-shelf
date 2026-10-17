import { createContext, useContext } from 'react';

export const ServerAvailable = createContext(true);
export const useServerAvailable = () => useContext(ServerAvailable);
