FROM nginx:alpine

RUN apk add --no-cache openssl \
    && rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/ /etc/nginx/conf.d/
COPY cloudflare-allow.conf /etc/nginx/cloudflare-allow.conf
COPY proxy-app.conf /etc/nginx/proxy-app.conf
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY cloudflare-origin-pull-ca.pem /etc/nginx/cloudflare-origin-pull-ca.pem
COPY cloudflare-origin-pull-ca.metadata /etc/nginx/cloudflare-origin-pull-ca.metadata
COPY proxy-entrypoint.sh /usr/local/bin/proxy-entrypoint.sh

RUN chmod 755 /usr/local/bin/proxy-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/proxy-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
