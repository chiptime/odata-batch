# odata-batch

This module formats both the request and response of batch operations. It supports **OData v2** but it may also support **OData V3**.

## Install

`npm install odata-batch --save`

## Example
You only need to generate an array with the requests you want to send, the requests will be returned in the same order as in the array.

    const { ODataBatch } = require('odata-batch')

    const calls = [
        {
            "method": "PUT",
            "url": "https://****",
            "headers": {
                "Content-Type": "application/json;charset=UTF-8;IEEE754Compatible=true",
                "Accept": "application/json;charset=UTF-8;IEEE754Compatible=true",
                "IF-Match": "*"
            },
            "data": {
                "__metadata": {
                    "uri": "Candidate('200')"
                },
                "name": "Sebastian"
            }
        },
        {
            "method": "PUT",
            "url": "https://****",
            "data": {
                "__metadata": {
                    "uri": "Candidate('201')"
                },
                "name": "Bruno"
            }
        },
        {
            "method": "POST",
            "url": "https://****",
            "data": {
                "__metadata": {
                    "uri": "Candidate"
                },
                "name": "Test"
            }
        },
    ];

    // Can add your own headers. Authorization header will be override auth param. Accept and Content-type headers will be ignored.
    const headers = {
        'Accept-Charset': 'utf-8',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en-US',
        'Cache-Control': 'no-cache'
    };

    const config = {
        url: `https://*****/$batch`,
        headers,
        auth: '******', // base64 string for basic auth
        calls,
    };

    var batchOperation = new ODataBatch(config);

    batchOperation.send()
        .then(async function (a) {
            console.log(a);
        })
        .catch(function (e) {
            console.error(e);
        });


## Extends

By default, axios is used as the HTTP connection library, but you can create your own adapter for your preferred HTTP library.

You need a class with a method send that will recieve necesary data for create the request and a class for format the batch response. Need as second param an object with data and headers.
In method send of your class, you will recieve the next params:
+ url: url of your system
+ batchRequest: raw response from odata
+ config: an object with headers that we will use for batch request, add more configs if you need.
+ accept: is the response type in each individual batch subquery, is necessary for format correctly individual responses.
+ BatchParser: class that will parse the response.

Additionally, to respect the typescript typing, we use a `createBatchResponse` function to create the class, export it from the module.

`ODataBatchAxiosRepository.ts`


    import axios, { AxiosRequestConfig } from 'axios';
    import {
        ODataBatchRepository,
        createBatchResponse,
        BatchResponseConstructor
        } from "odata-batch";

    export class ODataBatchAxiosRepository implements     ODataBatchRepository {
        async send(
            url: string,
            batchRequest: string,
            config: AxiosRequestConfig | undefined,
            accept: string,
            BatchParser: BatchResponseConstructor
        ): Promise<any> {

            const request = await axios.post(url,     batchRequest, config);

            console.log('from custom adapter');

            return createBatchResponse(BatchParser,     request, accept).response;
        }
    }


Based in:
+ [batchcall](https://www.npmjs.com/package/batchcall)
+ [batch-odata](https://www.npmjs.com/package/batch-odata)