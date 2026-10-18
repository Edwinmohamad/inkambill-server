FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache bash tesseract-ocr tesseract-ocr-data-ind
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 3200
CMD ["npm","start"]
